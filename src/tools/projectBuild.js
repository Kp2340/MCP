import { exec } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { BUILD_TIMEOUT_MS } from "../core/constants.js";

/**
 * project_build — Run the project build command.
 *
 * Improvements:
 *   - Enforces BUILD_TIMEOUT_MS (120s) — prevents infinite hangs
 *   - Returns structured { success, exitCode, output } for better error parsing
 *   - Caps output at 8000 chars to avoid flooding the agent context
 */
export function buildProject({ project }) {
    const config = getProject(project);

    return new Promise((resolve) => {
        const proc = exec(
            config.buildCommand,
            { cwd: config.root, timeout: BUILD_TIMEOUT_MS },
            (error, stdout, stderr) => {
                const output   = ((stdout || "") + "\n" + (stderr || "")).trim();
                const success  = !error;
                const exitCode = error?.code ?? 0;

                // Prefix with status so the agent can detect success/failure in one glance
                const prefix   = success
                    ? "BUILD SUCCESS\n"
                    : `BUILD FAILED (exit ${exitCode})\n`;

                resolve({
                    content: [{
                        type: "text",
                        text: (prefix + output).substring(0, 8000)
                    }],
                    success
                });
            }
        );

        // Belt-and-suspenders timeout kill
        setTimeout(() => {
            try { proc.kill(); } catch { /* already exited */ }
            resolve({
                content: [{ type: "text", text: `BUILD TIMEOUT after ${BUILD_TIMEOUT_MS / 1000}s` }],
                success: false
            });
        }, BUILD_TIMEOUT_MS + 5000);
    });
}