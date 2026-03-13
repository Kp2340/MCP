import { exec } from "child_process";
import { getProject } from "../core/projectRegistry.js";

export function buildProject({ project }) {

    const config = getProject(project);

    return new Promise((resolve) => {

        exec(config.buildCommand, {
            cwd: config.root
        }, (err, stdout, stderr) => {

            resolve({
                success: !err,
                stdout,
                stderr
            });

        });

    });

}