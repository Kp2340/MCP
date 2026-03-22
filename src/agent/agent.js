import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan, updatePlan, estimateTokens, handleFailureDeterministically } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext, classifyIntentFromPrompt } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { TrainingCollector } from "../training/collector.js";
import { storeMemory, queryMemory } from "../vector/memory.js";
import { askLLM } from "./ollamaClient.js";
import { makeExecutionState, formatStateForPrompt } from "./executionState.js";
import { executeToolChain, executeToolsDirect } from "./toolChainExecutor.js";
import { executeUiEdit } from "./uiEditExecutor.js";
import { validateGoal, logValidation, validateWithBuild } from "./goalValidator.js";
import { reviewChanges } from "./reviewer.js";
import { fileURLToPath } from "url";
import { runValidationPipeline, issuesAsSteps } from "./validationPipeline.js";
import {
    COMPRESS_EVERY_N_STEPS,
    COMPRESS_MAX_CHARS,
    MAX_LLM_CALLS_PER_RUN,
    MAX_TOTAL_TOKENS_PER_RUN,
    MAX_REPLANS,
    TOOL_CHAIN_TEMPLATES,
    LLM_MODEL
} from "../core/constants.js";

process.env.NODE_NO_WARNINGS = "1";

const MODEL       = LLM_MODEL;
const MAX_STEPS   = 25;
const MAX_RETRIES = 2;

let mcp;
let collector;

// ─── Cost state ─────────────────────────────────────────────────────────────────────────────
function makeCostState() {
    return { llmCalls: 0, totalChars: 0 };
}

function trackChars(costState, ...texts) {
    costState.totalChars += texts.reduce((s, t) => s + (t ? t.length : 0), 0);
}

function estimatedTokens(costState) {
    return estimateTokens("".padEnd(costState.totalChars, "x"));
}

// ─── Context compression ───────────────────────────────────────────────────────────
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

// ─── Memory extraction ────────────────────────────────────────────────────────────
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

// ─── Analyze-before-modify guard ──────────────────────────────────────────────────────────────────────────────
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

// ─── Step executor with retry ──────────────────────────────────────────────────────────────────────────
async function executeWithRetry(step, context, project, memoryCtx, costState, execState) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) console.error(`[agent] Retry ${attempt}/${MAX_RETRIES - 1}: ${step}`);
        const action = await executeStep(step, context, project, memoryCtx, costState, execState);
        trackChars(costState, action);
        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) { lastError = `Non-JSON: ${extracted.substring(0, 80)}`; continue; }
            const parsed = JSON.parse(extracted);
            if (parsed.skipped) return { ok: true, parsed };
            return { ok: true, parsed };
        } catch (err) { lastError = err.message; }
    }
    return { ok: false, error: lastError };
}

// ─── Main adaptive agent loop ──────────────────────────────────────────────────────────────────────
export async function runAgent(prompt, emit = null) {
    if (!mcp)       mcp       = new MCPClient();
    if (!collector) collector = new TrainingCollector();
    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);
    if (!projectMatch) throw new Error("Prompt must include: project: <project-name>");
    const project = projectMatch[1];

    const emitStep = (n, detail) => { try { if (emit) emit(n, detail); } catch {} };

    console.error("Project:", project);
    console.error("\nCreating plan...\n");

    const costState = makeCostState();
    const execState = makeExecutionState();

    const promptIntent = classifyIntentFromPrompt(prompt);
    console.error(`[agent] Prompt intent: ${promptIntent}`);

    const planContext    = await retrieveContext(prompt, project, execState);
    trackChars(costState, planContext);

    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;

    // ── Fast path: direct tool-chain template match (0 LLM calls) ──────────────────────────
    const matchedTemplate = TOOL_CHAIN_TEMPLATES.find(t => {
        const lower  = prompt.toLowerCase();
        const hits   = t.keywords.filter(kw => lower.includes(kw)).length;
        const intentOk = t.name === "ui_edit" || !t.intent || t.intent === promptIntent || t.intent === "general";
        return hits >= 2 && intentOk;
    });

    if (matchedTemplate) {
        console.error(`\n[agent] ⚡ Template "${matchedTemplate.name}" matched — executing directly`);

        let chainResult;
        if (matchedTemplate.name === "ui_edit") {
            chainResult = await executeUiEdit(prompt, project, mcp, execState, costState);
        } else {
            chainResult = await executeToolChain(matchedTemplate.name, project, mcp, execState, costState);
        }
        const { results, success, stepsRun } = chainResult;
        if (success || stepsRun > 0) {
            const executionContext = results.join("\n");
            collector.startRun(prompt);
            collector.endRun(stepsRun >= 2);
            if (stepsRun >= 2) await extractAndStoreMemory(project, prompt, executionContext, costState);

            const validation = validateGoal(promptIntent, execState);
            logValidation(promptIntent, validation);

            console.error(`\n─── Agent finished (direct chain) ───`);
            console.error(`  Steps:       ${stepsRun} (template: ${matchedTemplate.name})`);
            console.error(`  LLM calls:   ${costState.llmCalls} / ${MAX_LLM_CALLS_PER_RUN}`);
            console.error(`  Files read:  ${[...execState.filesRead].join(", ") || "none"}`);
            console.error(`  Files mod:   ${[...execState.filesModified].join(", ") || "none"}`);
            return;
        }
        console.error("[agent] Direct chain insufficient — falling back to full LLM loop");
    }

    // ── Full LLM planning loop ─────────────────────────────────────────────────────────────────────────────
    const initialPlan = await createPlan(enrichedPrompt, project, costState, promptIntent, execState);
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
    // earlyReviewDone: reviewer fires once, the first time a file is modified
    let earlyReviewDone  = false;

    collector.startRun(prompt);

    while (remainingSteps.length > 0 && totalStepsDone < MAX_STEPS) {

        // Token budget check
        const estTokens = estimatedTokens(costState);
        if (estTokens > MAX_TOTAL_TOKENS_PER_RUN) {
            console.error(`[agent] ⚠️  Token budget exceeded (~${estTokens} tokens). Stopping.`);
            break;
        }

        // Context compression every N steps
        if (totalStepsDone > 0 && totalStepsDone % COMPRESS_EVERY_N_STEPS === 0) {
            executionContext = await compressContext(executionContext, execState, costState);
        }

        const step = remainingSteps.shift();
        totalStepsDone++;

        console.error(`\n[${totalStepsDone}] ${step}`);
        console.error(`[cost] LLM: ${costState.llmCalls}/${MAX_LLM_CALLS_PER_RUN}  Tokens: ~${estimatedTokens(costState).toLocaleString()}/${MAX_TOTAL_TOKENS_PER_RUN.toLocaleString()}`);
        emitStep(totalStepsDone, step);

        const stepIntent  = classifyIntentFromPrompt(step);
        const memoryType  = stepIntent === "ui"  ? "architecture" :
                            stepIntent === "api" ? "architecture" :
                            stepIntent === "fix" ? "fix"          : null;

        const stepMemory  = await queryMemory(project, step, {
            minConfidence: 0.7,
            filterType:    memoryType,
            execState,
            intent:        stepIntent
        });

        const stepContext = await retrieveContext(step, project, execState);
        const stateBlock  = formatStateForPrompt(execState);
        const fullContext = executionContext +
            (stateBlock  ? `\n\n[Execution state]:\n${stateBlock}`  : "") +
            (stepContext ? `\n\n[Relevant code]:\n${stepContext}` : "");

        trackChars(costState, fullContext, stepMemory);

        const { ok, parsed, error } = await executeWithRetry(
            step, fullContext, project, stepMemory, costState, execState
        );

        if (!ok) {
            console.error(`[agent] Step failed after retries: ${error}`);
            continue;
        }

        if (parsed.skipped) {
            console.error(`[agent] Step skipped (already done)`);
            continue;
        }

        if (parsed.done) {
            console.error("[agent] Executor signalled done");
            break;
        }

        // ── Execute the resolved tool call ───────────────────────────────────────────────────────
        const { tool, args } = parsed;
        if (!tool) continue;

        // Check for deterministic recovery override before calling tool
        const activeError = execState.lastError();
        if (activeError) {
            const recoveryTools = handleFailureDeterministically(activeError.type, project, execState);
            if (recoveryTools) {
                console.error(`[agent] ⚡ Deterministic recovery triggered for: ${activeError.type}`);
                const { results: recResults } = await executeToolsDirect(recoveryTools, mcp, execState);
                executionContext += "\n" + recResults.join("\n");
                successfulSteps++;
                continue;
            }
        }

        let toolResult;
        try {
            toolResult = await mcp.callTool(tool, args);
        } catch (err) {
            console.error(`[agent] Tool call failed: ${tool} — ${err.message}`);
            execState.recordToolCall(tool, args, `Tool error: ${err.message}`, totalStepsDone);
            continue;
        }

        const resultText = toolResult?.content?.map(c => c.text || "").join("\n") || "";
        execState.recordToolCall(tool, args, resultText, totalStepsDone);
        executionContext += `\n\n[${tool}]:\n${resultText.substring(0, 2000)}`;
        successfulSteps++;

        console.error(`[agent] ← ${resultText.length} chars`);
        if (resultText.length < 500) console.error(resultText);

        // ── Early reviewer: fires once, right after the FIRST file is modified ───────────────────
        // Runs while budget is still high so injected recovery steps have room to execute.
        if (!earlyReviewDone && execState.filesModified.size >= 1 &&
            (MAX_LLM_CALLS_PER_RUN - costState.llmCalls) >= 4) {
            earlyReviewDone = true;
            const earlyReview = await reviewChanges(
                project, prompt, execState, costState, executionContext, true
            );
            if (earlyReview.verdict === "has_issues" && earlyReview.issues?.length > 0) {
                const recoverySteps = issuesAsSteps(earlyReview.issues);
                remainingSteps.unshift(...recoverySteps);
                console.error(`[agent] Early reviewer injected ${recoverySteps.length} recovery step(s)`);
            }
        }

        // ── Replan on repeated errors ──────────────────────────────────────────────────────────────────────
        const lastErr = execState.lastError();
        if (lastErr && remainingSteps.length === 0 && replanCount < MAX_REPLANS) {
            replanCount++;
            console.error(`[agent] Error detected, replanning (${replanCount}/${MAX_REPLANS})...`);
            const replanPrompt = `${enrichedPrompt}\n\nPrevious error: [${lastErr.type}] ${lastErr.text.substring(0, 200)}`;
            const newPlan = await createPlan(replanPrompt, project, costState, promptIntent, execState);
            const newSteps = enforceAnalyzeBeforeBuild(
                newPlan
                    .split("\n")
                    .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
                    .filter(s => s.length > 4)
            );
            remainingSteps.push(...newSteps);
            console.error(`[agent] Replan added ${newSteps.length} step(s)`);
        }
    }

    // ── Final validation pipeline ─────────────────────────────────────────────────────────────────────────
    const pipeline = await runValidationPipeline(
        promptIntent, project, execState, costState, mcp, prompt, executionContext
    );

    // Inject any final reviewer issues as extra steps (last-chance recovery)
    if (pipeline.issues?.length > 0 && remainingSteps.length === 0) {
        console.error(`[agent] Final reviewer has ${pipeline.issues.length} issue(s) — logged for next run`);
    }

    collector.endRun(successfulSteps >= 2, execState);
    if (successfulSteps >= 2) await extractAndStoreMemory(project, prompt, executionContext, costState);

    console.error(`\n─── Agent finished ───`);
    console.error(`  Steps done:   ${totalStepsDone}`);
    console.error(`  Successful:   ${successfulSteps}`);
    console.error(`  LLM calls:    ${costState.llmCalls} / ${MAX_LLM_CALLS_PER_RUN}`);
    console.error(`  Files read:   ${[...execState.filesRead].join(", ") || "none"}`);
    console.error(`  Files mod:    ${[...execState.filesModified].join(", ") || "none"}`);
    console.error(`  Validation:   heuristic=${pipeline.heuristic.passed} build=${pipeline.build.passed}`);
}

// ─── CLI entry point (when run directly: node src/agent/agent.js) ───────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Prompt: ", async (input) => {
        rl.close();
        try {
            await runAgent(input.trim());
        } catch (err) {
            console.error("Agent error:", err.message);
            process.exit(1);
        }
    });
}
