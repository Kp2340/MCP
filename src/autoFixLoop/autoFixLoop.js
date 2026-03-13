import { buildProject } from "../build/buildProject.js";
import { parseErrors } from "../build/parseBuildErrors.js";
import { askLLM } from "../agent/ollamaClient.js";
import { getProject } from "../core/projectRegistry.js";
import { applyChanges } from "../tools/applyChanges.js";

export async function runAutoFix(projectName) {

    const project = getProject(projectName);

    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {

        console.log("Running build attempt:", attempt + 1);

        const result = await buildProject({ project: projectName });

        if (result.success) {
            console.log("Build successful");
            return;
        }

        const errors = parseErrors(result.stderr);

        const prompt = `
Fix the following build errors.

Errors:
${errors.join("\n")}

Return JSON:

{
 "files":[
   {
     "path":"relative/path/file.js",
     "content":"corrected code"
   }
 ]
}
`;

        const response = await askLLM("qwen2.5-coder:7b", prompt);

        try {

            const patch = JSON.parse(response);

            await applyChanges({
                project: projectName,
                files: patch.files,
                commitMessage: "Auto fix",
                increment: false
            });

        } catch {
            console.log("Invalid patch returned");
        }
    }

    console.log("Auto fix attempts exceeded");
}