import { execSync } from "child_process";

export function createBranch(projectRoot) {
    const branch = `ai-${Date.now()}`;
    execSync(`git checkout -b ${branch}`, { cwd: projectRoot });
    return branch;
}

export function commitChanges(message, projectRoot) {
    execSync("git add .", { cwd: projectRoot });
    execSync(`git commit -m "${message}"`, { cwd: projectRoot });
}