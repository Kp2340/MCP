/**
 * Unified Validation Pipeline — MCP-3.5 P1
 *
 * Combines three validation sources into a single structured verdict:
 *   1. heuristic  — fast, zero I/O (validateGoal)
 *   2. build      — real system check (project_analyze via mcpClient)
 *   3. reviewer   — LLM post-review (only when budget permits + files changed)
 *
 * Output:
 *   {
 *     heuristic:  { passed, reason },
 *     build:      { passed, reason },
 *     reviewer:   { verdict, issues, confident } | null,
 *     passed:     boolean,   // true only if heuristic && build both pass
 *     issues:     string[]   // collected issues from reviewer for feedback loop
 *   }
 *
 * Reviewer feedback loop:
 *   If reviewer.verdict === "has_issues" → caller injects issues as extra steps
 */

import { validateGoal, logValidation, validateWithBuild } from "./goalValidator.js";
import { reviewChanges } from "./reviewer.js";

/**
 * Run the full validation pipeline.
 *
 * @param {string}         intent
 * @param {string}         project
 * @param {ExecutionState} execState
 * @param {object}         costState
 * @param {MCPClient}      mcpClient
 * @param {string}         prompt
 * @param {string}         executionContext
 * @returns {Promise<{heuristic, build, reviewer, passed, issues}>}
 */
export async function runValidationPipeline(
    intent, project, execState, costState, mcpClient, prompt, executionContext
) {
    // 1. Heuristic (fast, zero I/O)
    const heuristic = validateGoal(intent, execState);
    logValidation(intent, heuristic);

    // 2. Build-based (system-aware)
    const build = await validateWithBuild(project, intent, mcpClient);

    // 3. Reviewer (LLM, gated by budget + file modification count)
    // Threshold lowered from 2 → 1: single-file changes are the most common case
    // and the ones most likely to introduce subtle logic errors.
    let reviewer = null;
    if (execState.filesModified.size >= 1) {
        reviewer = await reviewChanges(project, prompt, execState, costState, executionContext);
    }

    // Compute unified verdict
    const passed = heuristic.passed && build.passed;
    const issues = reviewer?.issues || [];

    // Log unified summary
    const icon = passed ? "✅" : "❌";
    console.error(`
[pipeline] ${icon} Final validation: heuristic=${heuristic.passed}, build=${build.passed}${reviewer ? `, reviewer=${reviewer.verdict}` : ""}`);
    if (issues.length > 0) {
        console.error(`[pipeline] ⚠ Reviewer issues (${issues.length}): ${issues.slice(0, 3).join(" | ")}`);
    }

    return { heuristic, build, reviewer, passed, issues };
}

/**
 * Convert reviewer issues into injectable recovery steps.
 * Used by the reviewer feedback loop in agent.js.
 *
 * @param {string[]} issues   — from reviewer.issues
 * @returns {string[]}        — step descriptions to inject into remainingSteps
 */
export function issuesAsSteps(issues) {
    return issues.slice(0, 3).map(issue =>
        `Fix reviewer issue: ${issue.substring(0, 120)}`
    );
}
