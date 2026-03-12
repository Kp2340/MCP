import fs from "fs";
import path from "path";

function walkDir(dir, options, depth = 0) {
    const { maxDepth, extensions } = options;

    if (depth > maxDepth) return [];

    let results = [];

    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
            results.push({
                type: "directory",
                path: path.relative(options.root, fullPath)
            });

            results = results.concat(
                walkDir(fullPath, options, depth + 1)
            );
        } else {
            if (
                extensions.length === 0 ||
                extensions.some(ext => item.name.endsWith(ext))
            ) {
                results.push({
                    type: "file",
                    path: path.relative(options.root, fullPath)
                });
            }
        }
    }

    return results;
}

export function scanProject(projectRoot, extensions = [], maxDepth = 5) {
    if (!fs.existsSync(projectRoot)) {
        throw new Error("Project root does not exist: " + projectRoot);
    }

    const files = walkDir(projectRoot, {
        extensions,
        maxDepth,
        root: projectRoot
    });

    return {
        totalItems: files.length,
        items: files
    };
}