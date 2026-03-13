import fs from "fs";
import { getProject } from "../core/projectRegistry.js";
import { validatePath } from "../core/validator.js";
import { readFileLimited } from "../utils/fileUtils.js";
import { MAX_FILE_SIZE } from "../core/constants.js";

const BLOCKED = [
    ".env",
    ".xml",
    ".properties",
    ".config",
    ".yaml",
    ".yml"
];

export function readFiles({ project, paths }) {

    const root = getProject(project).root;
    const results = [];

    for (const p of paths) {

        const ext = p.substring(p.lastIndexOf("."));

        if (BLOCKED.includes(ext)) {
            results.push({
                path: p,
                error: "Access denied"
            });
            continue;
        }

        try {

            const full = validatePath(root, p);

            if (!fs.existsSync(full)) {
                results.push({ path: p, error: "File not found" });
                continue;
            }

            const content = readFileLimited(full, MAX_FILE_SIZE);

            results.push({
                path: p,
                content
            });

        } catch (err) {

            results.push({
                path: p,
                error: err.message
            });
        }
    }

    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(results, null, 2)
            }
        ]
    };
}