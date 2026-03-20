import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan, updatePlan, estimateTokens } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext, classifyIntentFromPrompt } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { TrainingCollector } from "../training/collector.js";
import { storeMemory, queryMemory } from "../vector/memory.js";
import { askLLM } from "./ollamaClient.js";
import { makeExecutionState, formatStateForPrompt } from "./executionState.js";
import {
    COMPRESS_EVERY_N_STEPS,
    COMPRESS_MAX_CHARS,
    MAX_LLM_CALLS_PER_RUN,
    MAX_TOTAL_TOKENS_PER_RUN,
    MAX_REPLANS
} from "../core/constants.js";

process.env.NODE_NO_WARNINGS = "1";

const MODEL       = "qwen2.5-coder:7b";
const MAX_STEPS   = 25;
const MAX_RETRIES = 2;

const mcp       = new MCPClient();
const collector = new TrainingCollector();

console.error(`[training] ${collector.count()} examples collected so far`);

// ─── Cost state ──────────────────────────────────────────────────────────────
function makeCostState() {
    return { llmCalls: 0, totalChars: 0 };
}

// Real token estimate: accumulates actual prompt/response char counts
function trackChars(costState, ...texts) {
    costState.totalChars += texts.reduce((s, t) => s + (t ? t.length : 0), 0);
}

function estimatedTokens(costState) {
    return estimateTokens("".padEnd(costState.totalChars, "x"));
}

// ─── Context compression ─────────────────────────────────────────────────────
async function compressContext(context, execState, costState) {
    if (context.length < COMPRESS_MAX_CHARS) return context;
    console.error("[agent] Compressing context...");
    if (costState) costState.llmCalls++;

    const stateBlock = formatStateForPrompt(execState);
    const prompt = `Summarise the following code agent execution log in 3-5 bullet points.
Focus on: what files were read, what changes were made, what errors were found.
Be concise. Output only the bullet points.

Execution state:
${stateBlock}

${context.substring(0, COMPRESS_MAX_CHARS)}`;

    trackChars(costState, prompt);
    const summary = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 400 });
    trackChars(costState, summary);

    console.error("[agent] Context compressed.");
    return `[Compressed context summary]:\n${summary}\n\nExecution state:\n${stateBlock}`;
}

// ─── Memory extraction ───────────────────────────────────────────────────────
async function extractAndStoreMemory(project, prompt, context, costState) {
    try {
        if (costState) costState.llmCalls++;
        const raw = await askLLM(MODEL,
            `Based on this coding agent run, output ONLY a JSON object describing one architecture pattern observed.
Fields: type ("architecture"|"fix"|"pattern"|"convention"), pattern (string, max 120 chars), files (array of relevant filenames, max 3), confidence (0.0-1.0)
Output ONLY the JSON, nothing else.

Task: ${prompt.substring(0, 200)}
Context: ${context.substring(0, 800)}`,
            { temperature: 0.1, num_predict: 120 }
        );
        let structured;
        try { structured = JSON.parse(extractJSON(raw)); } catch { structured = null; }
        if (structured?.pattern && structured.pattern.length > 20) {
            await storeMemory(project, structured, structured.type || "pattern");
        }
    } catch (err) {
        console.error("[agent] Memory extraction failed:", err.message);
    }
}

// ─── Analyze-before-modify guard ─────────────────────────────────────────────────
function enforceAnalyzeBeforeBuild(steps) {
    const ANALYZE_KEYWORDS = /(analyze|analyse|static.?analy|project_analyze)/i;
    const hasAnalyze = steps.some(s => ANALYZE_KEYWORDS.test(s));
    if (hasAnalyze) return steps;
    const BUILD_KEYWORDS  = /(build|apply.?change|str.?replace|commit|modify|write)/i;
    const firstBuildIdx   = steps.findIndex(s => BUILD_KEYWORDS.test(s));
    if (firstBuildIdx === -1) return steps;
    const injected = [...steps];
    injected.splice(firstBuildIdx, 0, "Run static analysis to identify issues before building");
    console.error(`[agent] Injected project_analyze before step ${firstBuildIdx + 1}`);
    return injected;
}

// ─── Step executor with retry ────────────────────────────────────────────────
async function executeWithRetry(step, context, project, memoryCtx, costState) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) console.error(`[agent] Retry ${attempt}/${MAX_RETRIES - 1}: ${step}`);
        const action = await executeStep(step, context, project, memoryCtx, costState);
        trackChars(costState, action);
        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) { lastError = `Non-JSON: ${extracted.substring(0, 80)}`; continue; }
            const parsed = JSON.parse(extracted);
            return { ok: true, parsed };
        } catch (err) { lastError = err.message; }
    }
    return { ok: false, error: lastError };
}

// ─── Main adaptive agent loop ────────────────────────────────────────────────
async function runAgent(prompt) {
    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);
    if (!projectMatch) throw new Error("Prompt must include: project: <project-name>");
    const project = projectMatch[1];

    console.error("Project:", project);
    console.error("\nCreating plan...\n");

    const costState = makeCostState();
    const execState = makeExecutionState();

    // Classify intent from prompt before retrieval so planner + heuristic can use it
    const promptIntent = classifyIntentFromPrompt(prompt);
    console.error(`[agent] Prompt intent: ${promptIntent}`);

    const planContext    = await retrieveContext(prompt, project);
    trackChars(costState, planContext);

    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;
    const initialPlan    = await createPlan(enrichedPrompt, project, costState, promptIntent);
    trackChars(costState, initialPlan);

    console.error("\nInitial Plan:\n" + initialPlan);

    let remainingSteps = enforceAnalyzeBeforeBuild(
        initialPlan
            .split("\n")
            .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
            .filter(s => s.length > 4)
    );

    let executionContext = planContext;
    let successfulSteps  = 0;
    let totalStepsDone   = 0;
    let replanCount      = 0;

    collector.startRun(prompt);

    while (remainingSteps.length > 0 && totalStepsDone < MAX_STEPS) {

        // Real token budget check
        const estTokens = estimatedTokens(costState);
        if (estTokens > MAX_TOTAL_TOKENS_PER_RUN) {
            console.error(`[agent] ⚠️  Token budget exceeded (~${estTokens} tokens). Stopping.`);
            break;
        }

        // Compress every N steps
        if (totalStepsDone > 0 && totalStepsDone % COMPRESS_EVERY_N_STEPS === 0) {
            executionContext = await compressContext(executionContext, execState, costState);
        }

        const step = remainingSteps.shift();
        totalStepsDone++;

        console.error(`\n[${totalStepsDone}] ${step}`);
        console.error(`[cost] LLM: ${costState.llmCalls}/${MAX_LLM_CALLS_PER_RUN}  Tokens: ~${estimatedTokens(costState).toLocaleString()}/${MAX_TOTAL_TOKENS_PER_RUN.toLocaleString()}`);

        // Intent-filtered memory for this specific step
        const stepIntent  = classifyIntentFromPrompt(step);
        const memoryType  = stepIntent === "ui"  ? "architecture" :
                            stepIntent === "api" ? "architecture" :
                            stepIntent === "fix" ? "fix"          : null;

        const stepMemory  = await queryMemory(project, step, {
            minConfidence: 0.7,
            filterType:    memoryType
        });

        const stepContext  = await retrieveContext(step, project);
        const stateBlock   = formatStateForPrompt(execState);
        const fullContext  = executionContext +
            (stateBlock ? `\n\n[Execution state]:\n${stateBlock}` : "") +
            (stepContext ? `\n\n[Relevant code]:\n${stepContext}` : "");

        trackChars(costState, fullContext, stepMemory);

        const { ok, parsed, error } = await executeWithRetry(
            step, fullContext, project, stepMemory, costState
        );

        // ── Parse failed ─────────────────────────────────────────────────────────────
        if (!ok) {
            console.warn(`[agent] Parse failed: ${error}`);
            if (replanCount < MAX_REPLANS) {
                replanCount++;
                console.error(`[agent] Replanning (${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, `Parse failure: ${error}`,
                    executionContext, project, costState, execState
                );
                remainingSteps = enforceAnalyzeBeforeBuild(revised);
                console.error(`[agent] ${remainingSteps.length} steps remain.`);
            }
            continue;
        }

        // ── Tool call ───────────────────────────────────────────────────────────────
        if (parsed.tool) {
            console.error(`  → ${parsed.tool}`);

            let resultText = "";
            let toolFailed = false;

            try {
                const result = await mcp.callTool(parsed.tool, parsed.args || {});
                resultText   = result?.content?.map(c => c.text || "").join("\n").substring(0, 3000) || "";
                trackChars(costState, resultText);

                console.error(`  ← ${resultText.length} chars`);
                if (resultText.length < 500) console.error(resultText);

            } catch (toolErr) {
                console.warn(`[agent] Tool error: ${toolErr.message}`);
                resultText = `Tool error: ${toolErr.message}`;
                toolFailed = true;
            }

            // Update structured execution state
            execState.recordToolCall(parsed.tool, parsed.args, resultText, totalStepsDone);
            toolFailed = toolFailed || execState.lastError()?.stepIndex === totalStepsDone;

            executionContext += `\n\n[Step ${totalStepsDone} — ${parsed.tool}]:\n${resultText}`;

            if (toolFailed && replanCount < MAX_REPLANS) {
                replanCount++;
                const failType = execState.lastError()?.type || "unknown";
                console.error(`[agent] ${failType} failure. Replanning (${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, resultText,
                    executionContext, project, costState, execState
                );
                remainingSteps = enforceAnalyzeBeforeBuild(revised);
                console.error(`[agent] ${remainingSteps.length} steps remain.`);
            }

            collector.logStep(step, { tool: parsed.tool, args: parsed.args }, resultText);
            successfulSteps++;
        }

        if (parsed.done) { console.error("\nTask completed\n"); break; }
    }

    collector.endRun(successfulSteps >= 2);
    if (successfulSteps >= 2) await extractAndStoreMemory(project, prompt, executionContext, costState);

    // ── Final summary ─────────────────────────────────────────────────────────────
    console.error(`\n─── Agent finished ───`);
    console.error(`  Steps:       ${successfulSteps} ok / ${totalStepsDone} total`);
    console.error(`  Replans:     ${replanCount}`);
    console.error(`  LLM calls:   ${costState.llmCalls} / ${MAX_LLM_CALLS_PER_RUN}`);
    console.error(`  Est tokens:  ~${estimatedTokens(costState).toLocaleString()} / ${MAX_TOTAL_TOKENS_PER_RUN.toLocaleString()}`);
    console.error(`  Files read:  ${[...execState.filesRead].join(", ") || "none"}`);
    console.error(`  Files mod:   ${[...execState.filesModified].join(", ") || "none"}`);
    if (execState.errors.length > 0) {
        console.error(`  Errors seen: ${execState.errors.map(e => e.type).join(", ")}`);
    }
    console.error(`──────────────────────\n`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Prompt: ", async (prompt) => {
    try {
        await runAgent(prompt);
    } catch (err) {
        console.error("Agent error:", err.message);
    }
    process.exit();
});
