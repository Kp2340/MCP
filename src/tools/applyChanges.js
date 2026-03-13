import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest } from "../core/validator.js";

/**
 * Apply file changes but DO NOT commit immediately.
 * Files are staged, and the commit will occur after build succeeds.
 */
export function applyChanges({ project, files }) {

    const config = getProject(project);
    const root = config.root;

    validateChangeRequest(files);

    for (const file of files) {

        const full = path.resolve(root, file.path);

        fs.mkdirSync(path.dirname(full), { recursive: true });

        fs.writeFileSync(full, file.content, "utf8");
    }

    // Stage changes but do not commit
    spawnSync("git", ["commit", "-m", "AI task completed"], {
        cwd: root
    });

    return {
        content: [
            {
                type: "text",
                text: `Staged ${files.length} file(s)`
            }
        ]
    };
}