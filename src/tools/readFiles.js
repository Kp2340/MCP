import fs from "fs";
import { getProject } from "../core/projectRegistry.js";
import { validatePath } from "../core/validator.js";
import { readFileLimited } from "../utils/fileUtils.js";
import { MAX_FILE_SIZE } from "../core/constants.js";

export function readFiles({ project, paths }) {
    const projectRoot = getProject(project).root;
    const results = [];

    for (const relativePath of paths) {
        try {
            const fullPath = validatePath(projectRoot, relativePath);

            if (!fs.existsSync(fullPath)) {
                results.push({ path: relativePath, error: "File not found" });
                continue;
            }

            const content = readFileLimited(fullPath, MAX_FILE_SIZE);
            results.push({ path: relativePath, content });

        } catch (err) {
            results.push({ path: relativePath, error: err.message });
        }
    }

    return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
    };
}
