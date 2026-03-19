import { buildProject } from "../build/buildProject.js";
import { parseErrors } from "../build/parseBuildErrors.js";
import { askLLM } from "../agent/ollamaClient.js";
import { getProject } from "../core/projectRegistry.js";
import { applyChanges } from "../tools/applyChanges.js";
import { safeParse } from "../utils/jsonUtils.js";
import fs from "fs";
import path from "path";

const MODEL = "qwen2.5-coder:7b";
const MAX_ATTEMPTS = 5;

/**
 * Parse file paths from error messages so we can send file context to the LLM.
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

    return [...files].slice(0, 4);  // Max 4 files to keep prompt size reasonable
}

function readFilesSafe(filePaths, projectRoot, maxChars = 2000) {
    const results = [];
    for (const rel of filePaths) {
        try {
            const full = path.resolve(projectRoot, rel);
            const content = fs.readFileSync(full, "utf8").substring(0, maxChars);
            results.push(`--- ${rel} ---\n${content}`);
        } catch {
            // File unreadable, skip
        }
    }
    return results.join("\n\n");
}

export async function runAutoFix(projectName) {
    const project = getProject(projectName);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        console.log(`[autofix] Build attempt ${attempt + 1}/${MAX_ATTEMPTS}`);

        const result = await buildProject({ project: projectName });

        if (result.success) {
            console.log("[autofix] Build successful");
            return { success: true, attempts: attempt + 1 };
        }

        const errors = parseErrors(result.stderr || result.stdout || "");

        if (errors.length === 0) {
            console.log("[autofix] Build failed but no parseable errors — stopping");
            break;
        }

        console.log(`[autofix] Found ${errors.length} error(s). Asking LLM to fix...`);

        // Read source files mentioned in errors for context
        const errorFiles = extractFilesFromErrors(errors, project.root);
        const fileContext = readFilesSafe(errorFiles, project.root);

        const prompt = `Fix the following build errors. Output ONLY a JSON object, no explanation.

Build errors:
${errors.slice(0, 20).join("\n")}

Relevant source files:
${fileContext || "(no source files found)"}

Return this exact JSON format:
{
  "files": [
    {
      "path": "relative/path/to/file.js",
      "content": "complete corrected file content here"
    }
  ]
}

JSON:`;

        const response = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 4096 });
        const { ok, value } = safeParse(response);

        if (!ok || !Array.isArray(value?.files)) {
            console.warn("[autofix] LLM returned invalid patch — retrying");
            continue;
        }

        console.log(`[autofix] Applying ${value.files.length} file fix(es)...`);

        try {
            await applyChanges({
                project: projectName,
                files: value.files,
                commitMessage: `Auto-fix attempt ${attempt + 1}`,
                increment: false
            });
        } catch (err) {
            console.warn("[autofix] Could not apply patch:", err.message);
        }
    }

    console.log("[autofix] Max attempts reached");
    return { success: false, attempts: MAX_ATTEMPTS };
}