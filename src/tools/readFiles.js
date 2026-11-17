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
            // FIX: use let so the path can be reassigned during fallback search
            let fullPath = validatePath(projectRoot, relativePath);

            if (!fs.existsSync(fullPath)) {
                // Auto-search common subdirectories before giving up
                // Added "addons" for Odoo, "lib" for Go/generic
                const searchDirs = [
                    "src/components", "src/app", "src", "app",
                    "components", "addons", "lib", "pkg"
                ];
                let found = false;
                for (const dir of searchDirs) {
                    try {
                        const candidate = validatePath(projectRoot, `${dir}/${relativePath}`);
                        if (fs.existsSync(candidate)) {
                            fullPath = candidate;
                            found = true;
                            break;
                        }
                    } catch { /* invalid path — skip */ }
                }
                if (!found) {
                    results.push({ path: relativePath, error: "File not found" });
                    continue;
                }
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
