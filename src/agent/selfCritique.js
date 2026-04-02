/**
 * src/agent/selfCritique.js
 *
 * Self-Critique Loop — the agent checks its own tool call before executing it.
 *
 * The single most common failure in coding agents is:
 *   str_replace fails because "search" string doesn't exist verbatim in the file.
 *
 * This happens because:
 *   1. The LLM generates a search string from its context (which may be stale)
 *   2. The file was modified earlier in the run
 *   3. The search string has whitespace or line-ending differences
 *
 * Self-critique catches this BEFORE the tool call by:
 *   1. For str_replace: verifying the search string EXISTS in the current file
 *   2. For apply_changes: checking file paths are valid and content isn't empty
 *   3. For any tool: checking required fields are present and non-empty
 *
 * When a problem is found, it returns a corrected tool call or a diagnostic
 * that the agent can act on — no wasted tool invocation.
 *
 * This is synchronous for str_replace verification (just reads the file),
 * and LLM-assisted for semantic correctness (optional, costs 1 LLM call).
 */

import fs   from "fs";
import path from "path";
import { getProject }  from "../core/projectRegistry.js";
import { validatePath } from "../core/validator.js";
import { askLLM }      from "./ollamaClient.js";
import { LLM_MODEL, NUM_PREDICT } from "../core/constants.js";

const MODEL = LLM_MODEL;

// ── Deterministic checks ──────────────────────────────────────────────────────

/**
 * Verify that a str_replace "search" string exists verbatim in the target file.
 * Returns { ok: true } if found, or { ok: false, reason, suggestion } if not.
 */
function verifyStrReplace(toolCall, projectName) {
    const edits = toolCall.args?.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        return { ok: false, reason: "str_replace has no edits array" };
    }

    const failures = [];
    for (const edit of edits) {
        if (!edit.path || !edit.search) {
            failures.push(`Edit missing path or search field: ${JSON.stringify(edit).substring(0, 100)}`);
            continue;
        }

        // Read the current file from disk
        let content;
        try {
            const project  = getProject(projectName);
            const fullPath = validatePath(project.root, edit.path);
            content = fs.readFileSync(fullPath, "utf-8");
        } catch (err) {
            failures.push(`Cannot read ${edit.path}: ${err.message}`);
            continue;
        }

        // Check 1: exact match
        if (content.includes(edit.search)) continue;  // ✔ found

        // Check 2: whitespace-normalised match (common LLM mistake: extra spaces, \r
 vs 
)
        // AUTO-CORRECT: instead of failing, extract the verbatim string from the file
        // and patch the edit in-place so the tool call can proceed without a re-read.
        const normaliseWs = s => s.replace(/\r
/g, "
").replace(/[ 	]+/g, " ");
        const normContent  = normaliseWs(content);
        const normSearch   = normaliseWs(edit.search);
        if (normContent.includes(normSearch)) {
            const idx         = normContent.indexOf(normSearch);
            // Measure the real span in the original (non-normalised) content.
            // Walk forward from idx until we have accumulated the same number of
            // non-whitespace characters as normSearch contains.
            const targetNonWs = normSearch.replace(/\s/g, "").length;
            let collected = 0;
            let end = idx;
            while (end < content.length && collected < targetNonWs) {
                if (!/\s/.test(content[end])) collected++;
                end++;
            }
            // Extend to include trailing whitespace so replace boundaries are clean
            while (end < content.length && /[ 	]/.test(content[end])) end++;
            const actualStr = content.substring(idx, end);
            console.error(`[self-critique] ⚡ Auto-correcting whitespace mismatch in ${edit.path} (${edit.search.length}→${actualStr.length} chars)`);
            edit.search = actualStr;   // mutate in-place — caller receives corrected args
            continue;                  // ✔ corrected, no failure
        }

        // Check 3: first line match (maybe the search has extra context at the end)
        const firstLine = edit.search.split("
")[0].trim();
        if (firstLine.length > 10 && content.includes(firstLine)) {
            failures.push(
                `Search string not found verbatim in ${edit.path}, ` +
                `but first line "${firstLine.substring(0, 50)}" exists. ` +
                `The file was likely modified. Re-read ${edit.path} to get current content.`
            );
            continue;
        }

        failures.push(
            `Search string not found in ${edit.path}. ` +
            `Search started with: "${edit.search.substring(0, 60).replace(/
/g, "\
")}". ` +
            `The file was likely modified since last read. Re-read it first.`
        );
    }

    if (failures.length > 0) {
        return {
            ok: false,
            reason: failures.join("
"),
            suggestion: `Call project_read_files on the affected file(s) first to get current content, then retry str_replace.`
        };
    }
    return { ok: true };
}

/**
 * Verify an apply_changes tool call.
 */
function verifyApplyChanges(toolCall) {
    const files = toolCall.args?.files;
    if (!Array.isArray(files) || files.length === 0) {
        return { ok: false, reason: "apply_changes has no files array" };
    }
    for (const file of files) {
        if (!file.path || typeof file.path !== "string") {
            return { ok: false, reason: `File entry missing path: ${JSON.stringify(file).substring(0, 80)}` };
        }
        if (!file.content || file.content.trim().length === 0) {
            return { ok: false, reason: `File ${file.path} has empty content` };
        }
    }
    return { ok: true };
}

// ── LLM-assisted semantic check ──────────────────────────────────────────────

/**
 * Ask the LLM to critique its own tool call for semantic correctness.
 * Only called for apply_changes and complex str_replace edits.
 *
 * @param {object} toolCall   — { tool, args }
 * @param {string} step       — the plan step this implements
 * @param {object} costState  — mutated
 * @returns {{ ok: boolean, issues: string[], corrected: object|null }}
 */
export async function llmCritique(toolCall, step, costState) {
    if (costState.llmCalls >= 28) {  // preserve last 2 calls for recovery
        return { ok: true, issues: [], corrected: null };
    }
    costState.llmCalls++;

    const callJson = JSON.stringify(toolCall, null, 2).substring(0, 1500);

    const prompt = `You are a code reviewer. Check if this tool call correctly implements the step.
Output ONLY a JSON object: { "ok": boolean, "issues": ["..."] }
If ok=true, issues must be empty. If ok=false, list specific problems.
Be brief. Max 2 issues.

Step: ${step}

Tool call:
${callJson}

JSON:`;

    try {
        const raw   = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 150 });
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return { ok: true, issues: [], corrected: null };
        const result = JSON.parse(match[0]);
        return {
            ok:        result.ok !== false,
            issues:    result.issues || [],
            corrected: null
        };
    } catch {
        return { ok: true, issues: [], corrected: null };
    }
}

// ── Main entry ───────────────────────────────────────────────────────────────────

/**
 * Run all applicable self-critique checks on a parsed tool call.
 * Fast deterministic checks first, optional LLM check if needed.
 *
 * @param {object}  toolCall     — { tool, args }
 * @param {string}  step         — the plan step
 * @param {string}  projectName
 * @param {object}  costState
 * @param {boolean} [useLLM=false]  — whether to run LLM semantic check
 * @returns {{ ok: boolean, reason?: string, suggestion?: string }}
 */
export async function selfCritique(toolCall, step, projectName, costState, useLLM = false) {
    const tool = toolCall?.tool;
    if (!tool) return { ok: false, reason: "Tool call has no tool field" };

    // ── Deterministic checks (zero LLM cost) ───────────────────────────────
    if (tool === "project_str_replace") {
        const check = verifyStrReplace(toolCall, projectName);
        if (!check.ok) {
            console.error(`[self-critique] ❌ str_replace pre-check failed:
${check.reason}`);
            return check;
        }
        console.error("[self-critique] ✔ str_replace search strings verified");
    }

    if (tool === "project_apply_changes") {
        const check = verifyApplyChanges(toolCall);
        if (!check.ok) {
            console.error(`[self-critique] ❌ apply_changes pre-check failed: ${check.reason}`);
            return check;
        }
    }

    // ── LLM semantic check ────────────────────────────────────────────────────
    // Runs automatically (not gated by useLLM flag) when:
    //   - tool is apply_changes (full file write — higher risk than str_replace)
    //   - OR caller explicitly requests it via useLLM=true
    //   - AND budget has at least 3 calls remaining (preserves recovery headroom)
    const shouldRunLLM = (
        tool === "project_apply_changes" || useLLM
    ) && costState.llmCalls < 27;  // 30 total − 3 reserved = 27 threshold

    if (shouldRunLLM) {
        const { ok, issues } = await llmCritique(toolCall, step, costState);
        if (!ok && issues.length > 0) {
            console.error(`[self-critique] ⚠ LLM critique: ${issues.join("; ")}`);
            return { ok: false, reason: issues.join("
"), suggestion: "Review the tool call arguments." };
        }
    }

    return { ok: true };
}
