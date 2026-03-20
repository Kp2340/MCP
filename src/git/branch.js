import { spawnSync } from "child_process";
import { sanitizeCommitMessage } from "../core/validator.js";

function getLatestBranchNumber(projectRoot, prefix) {
    const result = spawnSync("git", ["branch"], { cwd: projectRoot, encoding: "utf8" });
    const output = result.stdout || "";
    const regex = new RegExp(`${prefix}-(\\d+)`);
    let max = 0;
    for (const branch of output.split("\n")) {
        const match = branch.match(regex);
        if (match) {
            const num = parseInt(match[1]);
            if (num > max) max = num;
        }
    }
    return max;
}

export function createNextBranch(projectRoot, prefix) {
    const next = getLatestBranchNumber(projectRoot, prefix) + 1;
    const branchName = `${prefix}-${next}`;
    spawnSync("git", ["checkout", "-b", branchName], { cwd: projectRoot });
    return { branchName, number: next };
}
