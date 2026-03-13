import fs from "fs";
import path from "path";
import { IGNORE_FOLDERS } from "../core/constants.js";

export function buildDependencyGraph(root) {
    const graph = {};

    function walk(dir) {
        let items;
        try {
            items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const item of items) {
            // Skip ignored folders — this was missing before and caused node_modules crash
            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name)) continue;
                walk(path.join(dir, item.name));
                continue;
            }

            const full = path.join(dir, item.name);
            const ext = path.extname(item.name);

            if (![".js", ".ts", ".jsx", ".tsx", ".java"].includes(ext)) continue;

            try {
                const content = fs.readFileSync(full, "utf8");
                const relative = path.relative(root, full);

                // Match ES imports AND require() calls
                const importMatches = [
                    ...content.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g),
                    ...content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
                ];

                graph[relative] = importMatches.map(m => m[1]);
            } catch {
                // Unreadable file, skip
            }
        }
    }

    walk(root);
    return graph;
}
