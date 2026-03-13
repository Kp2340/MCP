import { exec } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { BUILD_TIMEOUT_MS } from "../core/constants.js";

export function buildProject({ project }) {
    const config = getProject(project);

    return new Promise((resolve) => {
        const proc = exec(
            config.buildCommand,
            {
                cwd: config.root,
                timeout: BUILD_TIMEOUT_MS,
                maxBuffer: 1024 * 1024 * 10  // 10MB output buffer
            },
            (error, stdout, stderr) => {
                const timedOut = error?.killed || error?.signal === "SIGTERM";

                resolve({
                    content: [{
                        type: "text",
                        text: timedOut
                            ? `Build timed out after ${BUILD_TIMEOUT_MS / 1000}s`
                            : (stdout + "\n" + stderr).trim()
                    }],
                    success: !error,
                    stdout,
                    stderr,
                    timedOut
                });
            }
        );

        proc.stdout?.on("data", (d) => process.stdout.write(`[build] ${d}`));
    });
}
