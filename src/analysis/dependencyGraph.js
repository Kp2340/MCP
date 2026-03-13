import fs from "fs";
import path from "path";

export function buildDependencyGraph(root) {

    const graph = {};

    function walk(dir) {

        const files = fs.readdirSync(dir);

        for (const f of files) {

            const full = path.join(dir, f);
            const stat = fs.statSync(full);

            if (stat.isDirectory()) {
                walk(full);
                continue;
            }

            if (
                full.endsWith(".js") ||
                full.endsWith(".ts") ||
                full.endsWith(".java")
            ) {

                const content = fs.readFileSync(full, "utf8");

                const imports =
                    content.match(/import\s+.*?\s+from\s+['"](.*?)['"]/g) || [];

                graph[full] = imports.map(i =>
                    i.match(/['"](.*?)['"]/)[1]
                );

            }

        }

    }

    walk(root);

    return graph;
}