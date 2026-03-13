import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest, sanitizeCommitMessage } from "../core/validator.js";
import { createNextBranch } from "../git/branch.js";

export function applyChanges({ project, files, commitMessage, increment }) {
    const config = getProject(project);
    const root = config.root;

    validateChangeRequest(files, root);

    // Write all files
    for (const file of files) {
        const full = path.resolve(root, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.content, "utf8");
    }

    // Stage all changes
    spawnSync("git", ["add", "."], { cwd: root });

    const safeMessage = sanitizeCommitMessage(commitMessage);

    if (increment) {
        // Create a new numbered branch
        const { branchName } = createNextBranch(root, config.branchPrefix);
        // FIX: use spawnSync with args array — no shell injection via commitMessage
        spawnSync("git", ["commit", "-m", `${branchName} ${safeMessage}`], { cwd: root });

        return {
            content: [{ type: "text", text: `Created branch ${branchName} and committed ${files.length} file(s)` }]
        };
    }

    spawnSync("git", ["commit", "-m", safeMessage], { cwd: root });

    return {
        content: [{ type: "text", text: `Committed ${files.length} file(s): ${safeMessage}` }]
    };
}
