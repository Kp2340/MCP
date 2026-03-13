import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import { buildProject } from "../build/buildProject.js";
import { parseErrors } from "../build/parseBuildErrors.js";
import { askLLM } from "../agent/ollamaClient.js";
import { getProject } from "../core/projectRegistry.js";
import { applyChanges } from "../tools/applyChanges.js";
import { safeParse } from "../utils/jsonUtils.js";

const MODEL = "qwen2.5-coder:7b";
const MAX_ATTEMPTS = 5;

function extractFilesFromErrors(errors, projectRoot) {

    const files = new Set();

    const regex = /([a-zA-Z0-9_./-]+\.(js|jsx|ts|tsx|java))(?::\d+)?/g;

    for (const err of errors) {

        let match;

        while ((match = regex.exec(err)) !== null) {

            const candidate = path.resolve(projectRoot, match[1]);

            if (fs.existsSync(candidate)) {
                files.add(match[1]);
            }
        }
    }

    return [...files].slice(0, 4);
}

function readFilesSafe(paths, projectRoot) {

    const results = [];

    for (const rel of paths) {

        try {

            const full = path.resolve(projectRoot, rel);

            const content = fs.readFileSync(full, "utf8").substring(0, 2000);

            results.push(`--- ${rel} ---\n${content}`);

        } catch {}
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

            // Commit once build succeeds
            spawnSync("git", ["commit", "-m", "AI task completed"], {
                cwd: project.root
            });

            return { success: true, attempts: attempt + 1 };
        }

        const errors = parseErrors(result.stderr || result.stdout || "");

        if (errors.length === 0) {
            console.log("[autofix] Build failed but no parseable errors");
            break;
        }

        console.log(`[autofix] Found ${errors.length} error(s)`);

        const errorFiles = extractFilesFromErrors(errors, project.root);

        const fileContext = readFilesSafe(errorFiles, project.root);

        const prompt = `Fix the following build errors.

Errors:
${errors.join("\n")}

Source files:
${fileContext}

Return JSON:
{
 "files":[
   {
     "path":"file",
     "content":"corrected file content"
   }
 ]
}
`;

        const response = await askLLM(MODEL, prompt, {
            temperature: 0.1,
            num_predict: 4096
        });

        const { ok, value } = safeParse(response);

        if (!ok || !Array.isArray(value?.files)) {
            console.warn("[autofix] Invalid LLM output");
            continue;
        }

        try {

            await applyChanges({
                project: projectName,
                files: value.files
            });

        } catch (err) {

            console.warn("[autofix] Apply failed:", err.message);
        }
    }

    return { success: false, attempts: MAX_ATTEMPTS };
}