import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";
import { IGNORE_FOLDERS } from "../core/constants.js";

function walkDir(dir, root, options, depth = 0) {

    const { extensions, maxDepth } = options;

    if (depth > maxDepth) return [];

    let results = [];

    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {

        if (IGNORE_FOLDERS.includes(item.name)) continue;

        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {

            results.push({
                type: "directory",
                path: path.relative(root, fullPath)
            });

            results = results.concat(
                walkDir(fullPath, root, options, depth + 1)
            );

        } else {

            if (
                extensions.length === 0 ||
                extensions.some(ext => item.name.endsWith(ext))
            ) {
                results.push({
                    type: "file",
                    path: path.relative(root, fullPath)
                });
            }

        }
    }

    return results;
}

export function scanProject({ project, extensions = [], maxDepth = 5 }) {

    const projectRoot = getProject(project).root;

    const files = walkDir(
        projectRoot,
        projectRoot,
        { extensions, maxDepth }
    );

    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(
                    { totalItems: files.length, items: files },
                    null,
                    2
                )
            }
        ]
    };
}