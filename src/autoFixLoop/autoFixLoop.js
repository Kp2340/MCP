/**
 * src/autoFixLoop/autoFixLoop.js
 *
 * Build-and-fix loop used by project_build_and_fix tool.
 *
 * Error parsing and recovery strategy now delegate to the same
 * DETERMINISTIC_RECOVERY_TOOLS and classifyFailure used by the main
 * agent planner — one code path for error recovery across the whole system.
 *
 * Flow:
 *   1. Run build
 *   2. If it passes → done
 *   3. Classify the error using executionState.classifyFailure
 *   4. If a deterministic recovery exists → run those tool calls directly
 *   5. Otherwise → fall back to LLM-generated str_replace / full_rewrite
 *   6. Repeat up to MAX_ATTEMPTS
 */

import { buildProject }   from "../tools/projectBuild.js";
import { askLLM } from "../agent/llmClient.js";
import { getProject }     from "../core/projectRegistry.js";
import { applyChanges }   from "../tools/applyChanges.js";
import { projectStrReplace } from "../tools/projectStrReplace.js";
import { analyzeProject } from "../tools/staticAnalyzer.js";
import { validatePath }   from "../core/validator.js";
import { safeParse }      from "../utils/jsonUtils.js";
import { classifyFailure, makeExecutionState } from "../agent/executionState.js";
import { DETERMINISTIC_RECOVERY_TOOLS } from "../agent/planner.js";
import { LLM_MODEL, NUM_PREDICT } from "../core/constants.js";
import { createLogger } from "../core/logger.js";
import fs   from "fs";
import path from "path";

const log        = createLogger("autofix");
const MODEL      = LLM_MODEL;
const MAX_ATTEMPTS = 5;

// ── Read files referenced in error lines ───────────────────────────────────────────────
function extractFilesFromOutput(output, projectRoot) {
    if (!output) return [];
    const pathPattern = /([a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|java|kt|go))(?::\d+)?/g;
    const files = new Set();
    let match;
    while ((match = pathPattern.exec(output)) !== null) {
        const candidate = path.resolve(projectRoot, match[1]);
        if (fs.existsSync(candidate)) files.add(match[1]);
    }
    return [...files].slice(0, 4);
}

function readFilesSafe(filePaths, projectRoot, maxChars = 2000) {
    return filePaths.map(rel => {
        try {
            const full    = path.resolve(projectRoot, rel);
            const content = fs.readFileSync(full, "utf8").substring(0, maxChars);
            return `--- ${rel} ---
${content}`;
        } catch { return null; }
    }).filter(Boolean).join("\n");
}

// ── Deterministic tool runner (same as toolChainExecutor.executeToolsDirect) ──────────────
// Inline here to avoid circular dep: autoFixLoop → toolChainExecutor → constants
async function runToolsDirect(toolSteps, projectName) {
    for (const { tool, args } of toolSteps) {
        log.info(`  → ${tool}`);
        try {
            if (tool === "project_str_replace") {
                await projectStrReplace({ ...args, project: projectName });
            } else if (tool === "project_apply_changes") {
                await applyChanges({ ...args, project: projectName });
            } else if (tool === "project_analyze") {
                await analyzeProject({ project: projectName });
            }
            // project_search / project_read_files are read-only; skip in autofix context
        } catch (err) {
            log.warn(`  Tool error (${tool}): ${err.message}`);
        }
    }
}

// ── LLM fallback fix ─────────────────────────────────────────────────────────────────────────────
async function llmFix(projectName, projectRoot, rawOutput, attempt) {
    const errorFiles  = extractFilesFromOutput(rawOutput, projectRoot);
    const fileContext = readFilesSafe(errorFiles, projectRoot);

    const prompt = `Fix the following build errors using TARGETED edits. Output ONLY a JSON object, no explanation.

Build output:
${rawOutput.substring(0, 3000)}

Relevant source files:
${fileContext || "(no source files found)"}

Prefer str_replace edits. Return EXACTLY one of:

Style A — targeted (PREFERRED):
{ "mode": "str_replace", "edits": [{ "path": "...", "search": "...", "replace": "..." }] }

Style B — full rewrite (only if entire file is broken):
{ "mode": "full_rewrite", "files": [{ "path": "...", "content": "..." }] }

JSON:`;

    const response    = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: NUM_PREDICT.autofix });
    const { ok, value } = safeParse(response);

    if (!ok || !value?.mode) {
        log.warn("LLM returned invalid patch — skipping");
        return;
    }

    const proj = getProject(projectName);

    if (value.mode === "str_replace" && Array.isArray(value.edits)) {
        const safeEdits = value.edits.filter(e => {
            try { validatePath(proj.root, e.path); return true; }
            catch { log.warn(`Skipping unsafe path: ${e.path}`); return false; }
        });
        if (safeEdits.length > 0) {
            await projectStrReplace({
                project:       projectName,
                edits:         safeEdits,
                commitMessage: `Auto-fix attempt ${attempt} (str_replace)`
            });
        }
    } else if (value.mode === "full_rewrite" && Array.isArray(value.files)) {
        const safeFiles = value.files.filter(f => {
            try { validatePath(proj.root, f.path); return true; }
            catch { log.warn(`Skipping unsafe path: ${f.path}`); return false; }
        });
        if (safeFiles.length > 0) {
            await applyChanges({
                project:       projectName,
                files:         safeFiles,
                commitMessage: `Auto-fix attempt ${attempt} (full_rewrite)`,
                increment:     false
            });
        }
    }
}

// ── Main export ────────────────────────────────────────────────────────────────────────────────────
export async function runAutoFix(projectName) {
    const proj = getProject(projectName);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        log.info(`Build attempt ${attempt}/${MAX_ATTEMPTS}`);

        const result    = await buildProject({ project: projectName });
        const rawOutput = result.content?.[0]?.text || "";

        // Build success: output contains a positive signal and no error markers
        const buildPassed = rawOutput.trim() === ""
            || /build successful|build success|0 error|tests passed|compiled successfully/i.test(rawOutput)
            || (/build skipped/i.test(rawOutput));  // Java/Kotlin — static analysis pass
        const buildFailed = !buildPassed &&
            /error|fail|exception|cannot find|unresolved/i.test(rawOutput);

        if (!buildFailed) {
            log.info("Build successful");
            return { success: true, attempts: attempt };
        }

        log.info(`Build failed on attempt ${attempt}`);

        // ── Step 1: try deterministic recovery (zero LLM) ───────────────────────────────
        const failureType = classifyFailure(rawOutput);
        if (failureType && failureType !== "unknown_error") {
            const fakeExecState = makeExecutionState();
            // Seed execState with the error so recovery tools have context
            fakeExecState.recordToolCall("project_build", { project: projectName }, rawOutput, 1);

            const recoveryFactory = DETERMINISTIC_RECOVERY_TOOLS[failureType];
            if (recoveryFactory) {
                const toolSteps = recoveryFactory(projectName, fakeExecState);
                log.info(`⚡ Deterministic recovery (${failureType}): ${toolSteps.length} tool call(s), 0 LLM`);
                await runToolsDirect(toolSteps, projectName);
                continue;  // re-build to check if fixed
            }
        }

        // ── Step 2: LLM fallback ───────────────────────────────────────────────────────────────────────────────
        log.info(`No deterministic fix for "${failureType || "unknown"}" — asking LLM...`);
        try {
            await llmFix(projectName, proj.root, rawOutput, attempt);
        } catch (err) {
            log.warn(`LLM fix failed: ${err.message}`);
        }
    }

    log.warn("Max attempts reached without successful build");
    return { success: false, attempts: MAX_ATTEMPTS };
}
