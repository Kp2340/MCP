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
import { reviewChanges } from "./reviewer.js";
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

// ─── Cost state ──────────────────────────────────────────────────────────────────
function makeCostState() {
    return { llmCalls: 0, totalChars: 0 };
}

function trackChars(costState, ...texts) {
    costState.totalChars += texts.reduce((s, t) => s + (t ? t.length : 0), 0);
}

function estimatedTokens(costState) {
    return estimateTokens("".padEnd(costState.totalChars, "x"));
}

// ─── Context compression ──────────────────────────────────────────────────────────
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

// ─── Memory extraction ───────────────────────────────────────────────────────────
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

// ─── Analyze-before-modify guard ────────────────────────────────────────────────────
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

// ─── Step executor with retry ────────────────────────────────────────────────────────
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

// ─── Main adaptive agent loop ───────────────────────────────────────────────────────
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

    // ── Fast path: direct tool-chain template match (0 LLM calls) ──────────────────────
    const matchedTemplate = TOOL_CHAIN_TEMPLATES.find(t => {
        const lower    = prompt.toLowerCase();
        const hits     = t.keywords.filter(kw => lower.includes(kw)).length;
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
            collector.endRun(stepsRun >= 2, execState);
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

    // ── Full LLM planning loop ──────────────────────────────────────────────────────────
    const initialPlan = await createPlan(enrichedPrompt, project, costState, promptIntent, execState);
    trackChars(costState, initialPlan);

    console.error("\nInitial Plan:\n" + initialPlan);

    let remainingSteps = enforceAnalyzeBeforeBuild(
        initialPlan
            .split("\n")
            .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
            .filter(s => s.length > 4)
    );

    let executionContext         = planContext;
    let successfulSteps          = 0;
    let totalStepsDone           = 0;
    let replanCount              = 0;
    // earlyReviewDone: reviewer fires once on first file modification
    let earlyReviewDone          = false;
    // reviewerIssuesInjected: inject issues back into queue only once
    let reviewerIssuesInjected   = false;

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

        // ── Deterministic recovery: handle failure tool steps directly (0 LLM) ────
        if (parsed.tool === "__deterministic_recovery__" && Array.isArray(parsed.toolSteps)) {
            console.error(`[agent] ⚡ Deterministic recovery: ${parsed.toolSteps.length} direct tool calls`);
            const { results } = await executeToolsDirect(parsed.toolSteps, mcp, execState);
            executionContext += "\n" + results.join("\n");
            successfulSteps++;
            continue;
        }

        // ── Execute the resolved tool call ───────────────────────────────────────────────
        const toolName = parsed.tool;
        const toolArgs = parsed.args || {};
        toolArgs.project = toolArgs.project || project;

        // Check execution state cache first (skip duplicate read calls)
        const cached = execState.getCachedResult(toolName, toolArgs);
        if (cached) {
            console.error(`[agent] ⚡ Cache hit: ${toolName} — skipping duplicate call`);
            executionContext += `\n[${toolName} cached]:\n${cached.substring(0, 500)}`;
            continue;
        }

        let resultText = "";
        try {
            const result = await mcp.callTool(toolName, toolArgs);
            resultText   = result?.content?.map(c => c.text || "").join("\n") || "";
        } catch (err) {
            console.error(`[agent] Tool error (${toolName}): ${err.message}`);
            resultText = `Tool error: ${err.message}`;
        }

        // Truncate very long results to keep context manageable
        const truncated = resultText.length > 4000
            ? resultText.substring(0, 4000) + "\n...[truncated]"
            : resultText;

        execState.recordToolCall(toolName, toolArgs, resultText, totalStepsDone);
        executionContext += `\n\n[${toolName}]:\n${truncated}`;
        trackChars(costState, truncated);
        successfulSteps++;

        // ── Training: log successful tool call trajectory ────────────────────────────
        collector.logStep(
            step,
            { tool: toolName, args: toolArgs },
            truncated,
            fullContext.substring(0, 600)   // snapshot of context at time of call
        );

        // ── Mid-run reviewer: fire once on first file modification ─────────────────
        if (!earlyReviewDone && execState.filesModified.size >= 1) {
            earlyReviewDone = true;
            const review = await reviewChanges(
                project, prompt, execState, costState, executionContext, true
            );

            // ── FIXED: inject reviewer issues back into remaining steps ────────
            if (
                !reviewerIssuesInjected &&
                review.verdict === "has_issues" &&
                Array.isArray(review.issues) &&
                review.issues.length > 0
            ) {
                const recoverySteps = issuesAsSteps(review.issues);
                remainingSteps.unshift(...recoverySteps);
                reviewerIssuesInjected = true;
                console.error(`[agent] 🔍 Reviewer injected ${recoverySteps.length} recovery step(s) into queue`);
            }
        }

        // ── Error-triggered replan (deterministic first, LLM fallback) ────────────
        const lastErr = execState.lastError();
        if (lastErr && lastErr.stepIndex === totalStepsDone) {
            const errorType = lastErr.type;
            console.error(`[agent] Error detected: ${errorType}`);

            // Try deterministic recovery first (0 LLM)
            const recoveryTools = handleFailureDeterministically(errorType, project, execState);
            if (recoveryTools) {
                console.error(`[agent] ⚡ Deterministic recovery for ${errorType}`);
                const { results: rResults } = await executeToolsDirect(recoveryTools, mcp, execState);
                executionContext += "\n" + rResults.join("\n");
            } else if (replanCount < MAX_REPLANS && costState.llmCalls < MAX_LLM_CALLS_PER_RUN) {
                // LLM replan fallback
                replanCount++;
                console.error(`[agent] Replanning (attempt ${replanCount}/${MAX_REPLANS})...`);
                const replan = await updatePlan(
                    enrichedPrompt, remainingSteps, executionContext,
                    errorType, project, costState, promptIntent, execState
                );
                if (replan) {
                    remainingSteps = enforceAnalyzeBeforeBuild(
                        replan
                            .split("\n")
                            .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
                            .filter(s => s.length > 4)
                    );
                    console.error(`[agent] Replan produced ${remainingSteps.length} new steps`);
                }
            }
        }
    } // end while

    // ── End-of-run validation pipeline ────────────────────────────────────────────────
    const validation = await runValidationPipeline(
        promptIntent, project, execState, costState, mcp, prompt, executionContext
    );

    // Inject final reviewer issues as extra steps if run ended early with budget
    if (
        !reviewerIssuesInjected &&
        validation.reviewer?.verdict === "has_issues" &&
        validation.issues?.length > 0 &&
        totalStepsDone < MAX_STEPS &&
        costState.llmCalls < MAX_LLM_CALLS_PER_RUN
    ) {
        const finalSteps = issuesAsSteps(validation.issues);
        console.error(`[agent] 🔍 Post-run reviewer injecting ${finalSteps.length} fix step(s)`);
        // Run them immediately as a mini-loop
        for (const fixStep of finalSteps) {
            if (totalStepsDone >= MAX_STEPS) break;
            totalStepsDone++;
            emitStep(totalStepsDone, fixStep);
            const stepMemory = await queryMemory(project, fixStep, { minConfidence: 0.7, execState });
            const stateBlock = formatStateForPrompt(execState);
            const fixCtx     = executionContext + (stateBlock ? `\n\n[Execution state]:\n${stateBlock}` : "");
            const { ok: fok, parsed: fp } = await executeWithRetry(
                fixStep, fixCtx, project, stepMemory, costState, execState
            );
            if (!fok || fp?.skipped || fp?.done) continue;
            try {
                const fResult    = await mcp.callTool(fp.tool, { ...(fp.args || {}), project });
                const fText      = fResult?.content?.map(c => c.text || "").join("\n") || "";
                const fTruncated = fText.length > 2000 ? fText.substring(0, 2000) + "\n..." : fText;
                execState.recordToolCall(fp.tool, fp.args, fText, totalStepsDone);
                executionContext += `\n\n[${fp.tool}]:\n${fTruncated}`;
            } catch (err) {
                console.error(`[agent] Fix step tool error: ${err.message}`);
            }
        }
    }

    // ── Persist training data for this run ───────────────────────────────────────────────
    const runSuccess = execState.filesModified.size > 0 && !execState.lastError();
    collector.endRun(runSuccess, execState);

    // ── Memory extraction (async, non-blocking) ─────────────────────────────────────
    if (successfulSteps >= 2) {
        extractAndStoreMemory(project, prompt, executionContext, costState).catch(() => {});
    }

    console.error(`\n─── Agent finished ───`);
    console.error(`  Steps done:   ${totalStepsDone}`);
    console.error(`  Successful:   ${successfulSteps}`);
    console.error(`  LLM calls:    ${costState.llmCalls} / ${MAX_LLM_CALLS_PER_RUN}`);
    console.error(`  Tokens:       ~${estimatedTokens(costState).toLocaleString()}`);
    console.error(`  Files read:   ${[...execState.filesRead].join(", ") || "none"}`);
    console.error(`  Files mod:    ${[...execState.filesModified].join(", ") || "none"}`);
    console.error(`  Validation:   heuristic=${validation.heuristic?.passed}, build=${validation.build?.passed}`);
    if (validation.reviewer) {
        console.error(`  Reviewer:     ${validation.reviewer.verdict} (confident: ${validation.reviewer.confident})`);
    }
}
