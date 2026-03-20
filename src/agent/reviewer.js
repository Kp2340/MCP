/**
 * Reviewer Agent — P2 upgrade
 *
 * A lightweight post-execution LLM review that checks:
 *   - logical correctness of applied changes
 *   - missing edge cases
 *   - bad or risky edits
 *
 * Fires AFTER the main agent loop when:
 *   - ≥2 files were modified
 *   - LLM budget has at least 2 calls remaining
 *
 * Output is logged only — does NOT block or revert changes.
 * Future: can feed back into a retry loop.
 */

import { askLLM } from "./ollamaClient.js";
import { MAX_LLM_CALLS_PER_RUN } from "../core/constants.js";

const MODEL = "qwen2.5-coder:7b";

/**
 * Review the agent's changes for correctness.
 *
 * @param {string}         project
 * @param {string}         originalPrompt
 * @param {ExecutionState} execState
 * @param {object}         costState        — { llmCalls, totalChars } — mutated
 * @param {string}         executionContext  — log of what happened
 * @returns {{ verdict: string, issues: string[], confident: boolean }}
 */
export async function reviewChanges(project, originalPrompt, execState, costState, executionContext) {
    // Budget guard — only run if enough LLM calls remain
    const remaining = MAX_LLM_CALLS_PER_RUN - costState.llmCalls;
    if (remaining < 2) {
        console.error("[reviewer] Skipping — insufficient LLM budget remaining");
        return { verdict: "skipped", issues: [], confident: false };
    }

    const modifiedFiles = [...execState.filesModified];
    if (modifiedFiles.length < 1) {
        console.error("[reviewer] Skipping — no files were modified");
        return { verdict: "skipped", issues: [], confident: false };
    }

    console.error(`\n[reviewer] 🔍 Reviewing ${modifiedFiles.length} modified file(s)...`);
    costState.llmCalls++;

    // Build a compact summary of what happened
    const stateLines = [
        `Project: ${project}`,
        `Goal: ${originalPrompt.substring(0, 200)}`,
        `Files modified: ${modifiedFiles.slice(0, 5).join(", ")}`,
        `Files read: ${[...execState.filesRead].slice(0, 5).join(", ")}`,
        `Errors encountered: ${execState.errors.map(e => e.type).join(", ") || "none"}`,
        `Total steps: ${execState.stepCount}`
    ].join("\n");

    // Truncated execution log for context
    const contextSnippet = executionContext.substring(executionContext.length - 2000);

    const prompt = `You are a senior code reviewer. Review the following coding agent run and assess correctness.

${stateLines}

Recent execution log:
${contextSnippet}

Output ONLY a JSON object with these fields:
- verdict: "correct" | "likely_correct" | "has_issues" | "needs_review"
- issues: array of strings describing specific problems (empty if none)
- confident: boolean (true if you have enough context to judge)

JSON:`;

    try {
        const raw = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 300 });
        costState.totalChars += prompt.length + raw.length;

        // Parse reviewer output
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in reviewer output");

        const result = JSON.parse(jsonMatch[0]);
        const icon   = result.verdict === "correct" || result.verdict === "likely_correct" ? "✅" : "⚠️";

        console.error(`[reviewer] ${icon} Verdict: ${result.verdict} (confident: ${result.confident})`);
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
