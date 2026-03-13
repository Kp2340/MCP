import { execSync } from "child_process";

export function commitChanges(projectRoot, message) {

    execSync("git add .", { cwd: projectRoot });

    execSync(`git commit -m "${message}"`, {
        cwd: projectRoot
    });
}