import path from "path";
import fs from "fs";
import { execSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest } from "../core/validator.js";

function getNextBranch(root, prefix) {

    const branches = execSync("git branch", { cwd: root }).toString();

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

    execSync("git add .", { cwd: root });

    if (increment) {

        const branch = getNextBranch(root, config.branchPrefix);

        execSync(`git checkout -b ${branch}`, { cwd: root });

        execSync(`git commit -m "${branch} ${commitMessage}"`, { cwd: root });

        return {
            content: [{
                type: "text",
                text: `Created branch ${branch}`
            }]
        };

    }

    execSync(`git commit -m "${commitMessage}"`, { cwd: root });

    return {
        content: [{
            type: "text",
            text: "Changes committed"
        }]
    };
}