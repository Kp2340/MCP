import { execSync } from "child_process";

function getLatestBranchNumber(projectRoot, prefix) {

    const output = execSync("git branch", {
        cwd: projectRoot
    }).toString();

    const branches = output.split("\n");

    let max = 0;

    const regex = new RegExp(`${prefix}-(\\d+)`);

    for (const branch of branches) {

        const match = branch.match(regex);

        if (match) {

            const num = parseInt(match[1]);

            if (num > max) {
                max = num;
            }
        }
    }

    return max;
}

export function createNextBranch(projectRoot, prefix) {

    const latest = getLatestBranchNumber(projectRoot, prefix);

    const next = latest + 1;

    const branchName = `${prefix}-${next}`;

    execSync(`git checkout -b ${branchName}`, {
        cwd: projectRoot
    });

    return {
        branchName,
        number: next
    };
}