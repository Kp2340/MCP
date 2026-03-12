import fs from "fs";
import path from "path";

export function applyFileChanges(files, projectRoot) {
    const results = [];

    for (const file of files) {
        const fullPath = path.resolve(projectRoot, file.path);

        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, "utf-8");

        results.push(`Updated: ${file.path}`);
    }

    return results.join("\n");
}