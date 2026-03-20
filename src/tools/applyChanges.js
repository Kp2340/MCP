import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest, sanitizeCommitMessage } from "../core/validator.js";

function getNextBranch(root, prefix) {
    const result = spawnSync("git", ["branch"], { cwd: root, encoding: "utf8" });
    const branches = result.stdout || "";
    let max = 0;
    const regex = new RegExp(`${prefix}-(\\d+)`);
    branches.split("\n").forEach(b => {
        const clean = b.replace("*", "").trim();
        const m = clean.match(regex);
        if (m) {
            const n = parseInt(m[1]);
            if (n > max) max = n;
        }
    });
    return `${prefix}-${max + 1}`;
}

export function applyChanges({ project, files, commitMessage, increment }) {
    const config = getProject(project);
    const root = config.root;

    validateChangeRequest(files, root);

    for (const file of files) {
        const full = path.resolve(root, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.content, "utf8");
    }

    spawnSync("git", ["add", "."], { cwd: root });

    const safeMessage = sanitizeCommitMessage(commitMessage);

    if (increment) {
        const branch = getNextBranch(root, config.branchPrefix);
        spawnSync("git", ["checkout", "-b", branch], { cwd: root });
        spawnSync("git", ["commit", "-m", `${branch} ${safeMessage}`], { cwd: root });
        return {
            content: [{ type: "text", text: `Created branch ${branch}` }]
        };
    }

    spawnSync("git", ["commit", "-m", safeMessage], { cwd: root });

    return {
        content: [{ type: "text", text: "Changes committed" }]
    };
}
