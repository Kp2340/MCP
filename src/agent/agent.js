import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan, updatePlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { TrainingCollector } from "../training/collector.js";
import { storeMemory, queryMemory } from "../vector/memory.js";
import { askLLM } from "./ollamaClient.js";
import {
    COMPRESS_EVERY_N_STEPS,
    COMPRESS_MAX_CHARS,
    MAX_LLM_CALLS_PER_RUN,
    MAX_TOTAL_TOKENS_PER_RUN,
    MAX_TOKENS_ESTIMATE_PER_CALL,
    MAX_REPLANS
} from "../core/constants.js";

process.env.NODE_NO_WARNINGS = "1";

const MODEL       = "qwen2.5-coder:7b";
const MAX_STEPS   = 25;
const MAX_RETRIES = 2;

const mcp       = new MCPClient();
const collector = new TrainingCollector();

console.error(`[training] ${collector.count()} examples collected so far`);

// ─── Cost state factory ─────────────────────────────────────────────────────
// Shared mutable state tracking LLM usage across planner + executor.
function makeCostState() {
    return { llmCalls: 0 };
}

function estimatedTokens(costState) {
    return costState.llmCalls * MAX_TOKENS_ESTIMATE_PER_CALL;
}

// ─── Context compression ─────────────────────────────────────────────────────
async function compressContext(context, costState) {
    if (context.length < COMPRESS_MAX_CHARS) return context;
    console.error("[agent] Compressing context...");
    if (costState) costState.llmCalls++;
    const summary = await askLLM(MODEL,
        `Summarise the following code agent execution log in 3-5 bullet points.
Focus on: what files were read, what changes were made, what errors were found.
Be concise. Output only the bullet points.

${context.substring(0, COMPRESS_MAX_CHARS)}`,
        { temperature: 0.1, num_predict: 400 }
    );
    console.error("[agent] Context compressed.");
    return `[Compressed context summary]:\n${summary}`;
}

// ─── Structured memory extraction ──────────────────────────────────────────────
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
// Enforces: project_analyze must run before any build or apply_changes.
// If the upcoming steps include a build/apply but no analyze precedes it,
// inject an analyze step immediately before the first such step.
function enforceAnalyzeBeforeBuild(steps) {
    const BUILD_TOOLS = new Set([
        "project_build_and_fix", "project_build",
        "project_apply_changes", "project_str_replace"
    ]);
    const ANALYZE_KEYWORDS = /(analyze|analyse|static.?analy|project_analyze)/i;

    // Check if any step already mentions analyze
    const hasAnalyze = steps.some(s => ANALYZE_KEYWORDS.test(s));
    if (hasAnalyze) return steps;  // already present — nothing to do

    // Find first step that implies a build or file write
    const BUILD_KEYWORDS = /(build|apply.?change|str.?replace|commit|modify|write)/i;
    const firstBuildIdx  = steps.findIndex(s => BUILD_KEYWORDS.test(s));
    if (firstBuildIdx === -1) return steps;  // no build step found

    // Inject analyze before that step
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
        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) { lastError = `Non-JSON: ${extracted.substring(0, 80)}`; continue; }
            const parsed = JSON.parse(extracted);
            return { ok: true, parsed };
        } catch (err) {
            lastError = err.message;
        }
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

    // Shared cost state — passed to planner + executor so both track LLM usage
    const costState = makeCostState();

    const planContext    = await retrieveContext(prompt, project);
    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;
    const initialPlan    = await createPlan(enrichedPrompt, project, costState);

    console.error("\nInitial Plan:\n" + initialPlan);

    // Parse + enforce analyze-before-build
    let remainingSteps = enforceAnalyzeBeforeBuild(
        initialPlan
            .split("\n")
            .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
            .filter(s => s.length > 4)
    );

    let executionContext = planContext;
    let successfulSteps = 0;
    let totalStepsDone  = 0;
    let replanCount     = 0;

    collector.startRun(prompt);

    while (remainingSteps.length > 0 && totalStepsDone < MAX_STEPS) {

        // Token budget warning
        const estTokens = estimatedTokens(costState);
        if (estTokens > MAX_TOTAL_TOKENS_PER_RUN) {
            console.error(`[agent] ⚠️  Estimated token usage (${estTokens}) exceeds budget (${MAX_TOTAL_TOKENS_PER_RUN}). Stopping.`);
            break;
        }

        // Compress context every N steps
        if (totalStepsDone > 0 && totalStepsDone % COMPRESS_EVERY_N_STEPS === 0) {
            executionContext = await compressContext(executionContext, costState);
        }

        const step = remainingSteps.shift();
        totalStepsDone++;

        console.error(`\n[${totalStepsDone}] Executing: ${step}`);
        console.error(`[cost] LLM calls so far: ${costState.llmCalls}/${MAX_LLM_CALLS_PER_RUN}`);

        // Fetch step-relevant memory — injected into executor prompt
        const stepMemory  = await queryMemory(project, step, { minConfidence: 0.7 });
        const stepContext = await retrieveContext(step, project);
        const fullContext = executionContext + (stepContext ? "\n\n" + stepContext : "");

        const { ok, parsed, error } = await executeWithRetry(
            step, fullContext, project, stepMemory, costState
        );

        // ── Parse failed after all retries ──────────────────────────────────────
        if (!ok) {
            console.warn(`[agent] Step failed to parse: ${error}`);
            if (replanCount < MAX_REPLANS) {
                replanCount++;
                console.error(`[agent] Replanning (${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, `Parse failure: ${error}`,
                    executionContext, project, costState
                );
                remainingSteps = enforceAnalyzeBeforeBuild(revised);
                console.error(`[agent] ${remainingSteps.length} steps remain after replan.`);
            }
            continue;
        }

        // ── Tool call ─────────────────────────────────────────────────────────────
        if (parsed.tool) {
            console.error(`\n  → ${parsed.tool}`);

            let resultText = "";
            let toolFailed = false;

            try {
                const result = await mcp.callTool(parsed.tool, parsed.args || {});
                resultText   = result?.content?.map(c => c.text || "").join("\n").substring(0, 3000) || "";

                console.error(`  ← ${resultText.length} chars`);
                if (resultText.length < 500) console.error(resultText);

                // Detect failure signals in result
                const lower = resultText.toLowerCase();
                toolFailed = lower.includes("error:") ||
                             lower.includes("build failed") ||
                             lower.includes("exception") ||
                             lower.includes("not found");

            } catch (toolErr) {
                console.warn(`[agent] Tool error: ${toolErr.message}`);
                resultText = `Tool error: ${toolErr.message}`;
                toolFailed = true;
            }

            executionContext += `\n\n[Step ${totalStepsDone} — ${parsed.tool}]:\n${resultText}`;

            if (toolFailed && replanCount < MAX_REPLANS) {
                replanCount++;
                console.error(`[agent] Tool failure. Replanning (${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, resultText,
                    executionContext, project, costState
                );
                remainingSteps = enforceAnalyzeBeforeBuild(revised);
                console.error(`[agent] ${remainingSteps.length} steps remain after replan.`);
            }

            collector.logStep(step, { tool: parsed.tool, args: parsed.args }, resultText);
            successfulSteps++;
        }

        if (parsed.done) { console.error("\nTask completed\n"); break; }
    }

    collector.endRun(successfulSteps >= 2);
    if (successfulSteps >= 2) await extractAndStoreMemory(project, prompt, executionContext, costState);

    // ── Cost summary ─────────────────────────────────────────────────────────────
    console.error(`\n─── Agent finished ───`);
    console.error(`  Steps:      ${successfulSteps} successful / ${totalStepsDone} total`);
    console.error(`  Replans:    ${replanCount}`);
    console.error(`  LLM calls:  ${costState.llmCalls} / ${MAX_LLM_CALLS_PER_RUN}`);
    console.error(`  Est tokens: ~${estimatedTokens(costState).toLocaleString()}`);
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
