import { spawnSync } from "child_process";

export function commitChanges(projectRoot, message) {
    // Use spawnSync with args array — no shell injection risk
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", message], { cwd: projectRoot });
}
