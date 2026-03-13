import { exec } from "child_process";
import { getProject } from "../core/projectRegistry.js";

export function buildProject({ project }) {

    const config = getProject(project);

    return new Promise((resolve) => {

        exec(
            config.buildCommand,
            { cwd: config.root },
            (error, stdout, stderr) => {

                resolve({
                    content: [
                        {
                            type: "text",
                            text: stdout + "\n" + stderr
                        }
                    ],
                    success: !error
                });

            }
        );

    });

}