/**
 * Reviewer Agent
 *
 * A lightweight post-execution LLM review that checks:
 *   - logical correctness of applied changes
 *   - missing edge cases
 *   - bad or risky edits
 *
 * TWO calling modes:
 *
 *   1. Mid-run review (reviewChanges called after FIRST file modification)
 *      — budget guard: requires ≥4 remaining LLM calls
 *      — fires early so issues can be injected as recovery steps while
 *        the agent loop still has budget to act on them
 *
 *   2. End-of-run review (legacy, called by validationPipeline)
 *      — budget guard: requires ≥2 remaining LLM calls
 *      — output logged only; issues surface in validation result
 *
 * reviewChanges() accepts an optional `earlyMode` flag to distinguish the two.
 */

import { askLLM } from "./llmClient.js";
import { MAX_LLM_CALLS_PER_RUN, LLM_MODEL, NUM_PREDICT } from "../core/constants.js";

const MODEL = LLM_MODEL;

/**
 * Review the agent's changes for correctness.
 *
 * @param {string}         project
 * @param {string}         originalPrompt
 * @param {ExecutionState} execState
 * @param {object}         costState         — { llmCalls, totalChars } — mutated
 * @param {string}         executionContext   — log of what happened
 * @param {boolean}        [earlyMode=false]  — true = mid-run, stricter budget gate
 * @returns {{ verdict: string, issues: string[], confident: boolean }}
 */
export async function reviewChanges(
    project, originalPrompt, execState, costState, executionContext, earlyMode = false
) {
    const minRemaining = earlyMode ? 4 : 2;
    const remaining    = MAX_LLM_CALLS_PER_RUN - costState.llmCalls;

    if (remaining < minRemaining) {
        console.error(`[reviewer] Skipping (${earlyMode ? "early" : "final"}) — insufficient LLM budget (${remaining} remaining, need ${minRemaining})`);
        return { verdict: "skipped", issues: [], confident: false };
    }

    const modifiedFiles = [...execState.filesModified];
    if (modifiedFiles.length < 1) {
        console.error("[reviewer] Skipping — no files were modified");
        return { verdict: "skipped", issues: [], confident: false };
    }

    const mode = earlyMode ? "early" : "final";
    console.error(`\n[reviewer] Reviewing ${modifiedFiles.length} modified file(s) [${mode} mode]...`);
    costState.llmCalls++;

    const stateLines = [
        `Project: ${project}`,
        `Goal: ${originalPrompt.substring(0, 200)}`,
        `Files modified: ${modifiedFiles.slice(0, 5).join(", ")}`,
        `Files read: ${[...execState.filesRead].slice(0, 5).join(", ")}`,
        `Errors encountered: ${execState.errors.map(e => e.type).join(", ") || "none"}`,
        `Total steps so far: ${execState.stepCount}`
    ].join("\n");

    const contextSnippet  = executionContext.substring(executionContext.length - 2000);
    const modifiedSummary = `\nFiles changed this run:\n${modifiedFiles.map(f => `  - ${f}`).join("\n")}`;

    const focusNote = earlyMode
        ? "\nFocus: are these early changes consistent with the goal? Flag anything that looks like a wrong-file edit, broken import, or logic error that will compound if not caught now."
        : "";

    const prompt = `You are a senior code reviewer. Review the following coding agent run and assess correctness.${focusNote}

${stateLines}

Recent execution log:
${contextSnippet}${modifiedSummary}

Output ONLY a JSON object with these fields:
- verdict: "correct" | "likely_correct" | "has_issues" | "needs_review"
- issues: array of strings describing specific problems (empty if none)
- confident: boolean (true if you have enough context to judge)

JSON:`;

    try {
        const raw = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: NUM_PREDICT.reviewer });
        costState.totalChars += prompt.length + raw.length;

        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in reviewer output");

        const result = JSON.parse(jsonMatch[0]);
        const icon   = result.verdict === "correct" || result.verdict === "likely_correct" ? "✅" : "⚠️";

        console.error(`[reviewer] ${icon} Verdict: ${result.verdict} (confident: ${result.confident}) [${mode}]`);
        if (result.issues?.length > 0) {
            result.issues.forEach(issue => console.error(`[reviewer]    ⚠ ${issue}`));
        } else {
            console.error("[reviewer]    No issues found");
        }

        return result;

    } catch (err) {
        console.error("[reviewer] Parse error:", err.message);
        return { verdict: "unknown", issues: [], confident: false };
    }
}
