import { spawnSync } from "child_process";
import { sanitizeCommitMessage } from "../core/validator.js";

export function commitChanges(projectRoot, message) {
    const safe = sanitizeCommitMessage(message);
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", safe], { cwd: projectRoot });
}
