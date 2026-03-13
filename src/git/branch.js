import { execSync } from "child_process";

function getLatestBranchNumber(projectRoot, prefix) {
    const output = execSync("git branch", { cwd: projectRoot }).toString();
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
    execSync(`git checkout -b ${branchName}`, { cwd: projectRoot });
    return { branchName, number: next };
}
