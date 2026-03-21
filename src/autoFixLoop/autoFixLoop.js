import { buildProject } from "../tools/projectBuild.js";
import { askLLM } from "../agent/ollamaClient.js";
import { getProject } from "../core/projectRegistry.js";
import { applyChanges } from "../tools/applyChanges.js";
import { projectStrReplace } from "../tools/projectStrReplace.js";
import { validatePath } from "../core/validator.js";
import { safeParse } from "../utils/jsonUtils.js";
import fs from "fs";
import path from "path";

import { LLM_MODEL, NUM_PREDICT } from "../core/constants.js";
const MODEL = LLM_MODEL;
const MAX_ATTEMPTS = 5;

/**
 * Extract error lines from raw build output.
 * Handles Java (javac/gradle), TypeScript (tsc), and generic patterns.
 */
/**
 * Extract true compiler/build error lines — avoids false positives from
 * log prefixes like "[ERROR]" that appear in successful Gradle runs.
 */
function parseErrors(output) {
    if (!output) return [];
    return output
        .split("\n")
        .map(l => l.trim())
        .filter(l =>
            // Java/Kotlin: "src/Foo.java:12: error: ..."
            /\.(java|kt|go):\d+: error:/i.test(l) ||
            // TypeScript/JS: "error TS1234:" or "SyntaxError:"
            /\berror\s+TS\d+:/i.test(l) ||
            /\bSyntaxError:/i.test(l) ||
            // Gradle/Maven task failure
            /TASK.*FAILED|BUILD FAILED/i.test(l) ||
            // Node.js: standard error format
            /^Error:/i.test(l)
        )
        .slice(0, 30);
}

/**
 * Parse file paths mentioned in error lines so we can send file context to LLM.
 * Handles patterns like: "src/components/Foo.jsx:42:5"
 */
function extractFilesFromErrors(errors, projectRoot) {
    const files = new Set();
    const pathPattern = /([a-zA-Z0-9_./-]+\.(js|jsx|ts|tsx|java|kt|go))(?::\d+)?/g;

    for (const err of errors) {
        let match;
        while ((match = pathPattern.exec(err)) !== null) {
            const candidate = path.resolve(projectRoot, match[1]);
            if (fs.existsSync(candidate)) {
                files.add(match[1]);
            }
        }
    }

    return [...files].slice(0, 4);
}

function readFilesSafe(filePaths, projectRoot, maxChars = 2000) {
    const results = [];
    for (const rel of filePaths) {
        try {
            const full = path.resolve(projectRoot, rel);
            const content = fs.readFileSync(full, "utf8").substring(0, maxChars);
            results.push(`--- ${rel} ---\n${content}`);
        } catch {
            // unreadable file, skip
        }
    }
    return results.join("\n\n");
}

export async function runAutoFix(projectName) {
    const project = getProject(projectName);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        console.error(`[autofix] Build attempt ${attempt + 1}/${MAX_ATTEMPTS}`);

        const result = await buildProject({ project: projectName });

        if (result.success) {
            console.error("[autofix] Build successful");
            return { success: true, attempts: attempt + 1 };
        }

        const rawOutput = result.content?.[0]?.text || "";
        const errors = parseErrors(rawOutput);

        if (errors.length === 0) {
            console.error("[autofix] Build failed but no parseable errors — stopping");
            break;
        }

        console.error(`[autofix] Found ${errors.length} error(s). Asking LLM to fix...`);

        const errorFiles = extractFilesFromErrors(errors, project.root);
        const fileContext = readFilesSafe(errorFiles, project.root);

        const prompt = `Fix the following build errors using TARGETED edits. Output ONLY a JSON object, no explanation.

Build errors:
${errors.slice(0, 20).join("\n")}

Relevant source files:
${fileContext || "(no source files found)"}

Prefer str_replace edits over full file rewrites.
Return this exact JSON format (choose ONE of the two styles):

Style A — targeted edits (PREFERRED, use when only a few lines change):
{
  "mode": "str_replace",
  "edits": [
    { "path": "relative/path/to/file.js", "search": "exact lines to find", "replace": "replacement lines" }
  ]
}

Style B — full rewrite (only use when the whole file is broken):
{
  "mode": "full_rewrite",
  "files": [
    { "path": "relative/path/to/file.js", "content": "complete corrected file content" }
  ]
}

JSON:`;

        const response = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: NUM_PREDICT.autofix });
        const { ok, value } = safeParse(response);

        if (!ok || !value?.mode) {
            console.warn("[autofix] LLM returned invalid patch — retrying");
            continue;
        }

        try {
            if (value.mode === "str_replace" && Array.isArray(value.edits)) {
                // Validate paths before applying
                const safeEdits = value.edits.filter(e => {
                    try { validatePath(project.root, e.path); return true; }
                    catch { console.warn(`[autofix] Skipping unsafe path: ${e.path}`); return false; }
                });
                if (safeEdits.length > 0) {
                    console.error(`[autofix] Applying ${safeEdits.length} str_replace edit(s)...`);
                    await projectStrReplace({
                        project: projectName,
                        edits: safeEdits,
                        commitMessage: `Auto-fix attempt ${attempt + 1} (str_replace)`
                    });
                }
            } else if (value.mode === "full_rewrite" && Array.isArray(value.files)) {
                const safeFiles = value.files.filter(f => {
                    try { validatePath(project.root, f.path); return true; }
                    catch { console.warn(`[autofix] Skipping unsafe path: ${f.path}`); return false; }
                });
                if (safeFiles.length > 0) {
                    console.error(`[autofix] Applying ${safeFiles.length} full rewrite(s)...`);
                    await applyChanges({
                        project: projectName,
                        files: safeFiles,
                        commitMessage: `Auto-fix attempt ${attempt + 1} (full_rewrite)`,
                        increment: false
                    });
                }
            }
        } catch (err) {
            console.warn("[autofix] Could not apply patch:", err.message);
        }
    }

    console.error("[autofix] Max attempts reached");
    return { success: false, attempts: MAX_ATTEMPTS };
}
