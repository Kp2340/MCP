import { exec } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { BUILD_TIMEOUT_MS } from "../core/constants.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("build");

export function buildProject({ project }) {
    const config = getProject(project);

    // Guard: no build command configured (Python, Odoo, plain Node, etc.)
    if (!config.buildCommand || config.buildCommand.trim() === "") {
        log.info(`project_build: no buildCommand for "${project}" (type: ${config.type}) — skipping`);
        return Promise.resolve({
            content: [{ type: "text", text: `BUILD SKIPPED — no build command configured for project type "${config.type}". Files written successfully.` }],
            success: true
        });
    }

    return new Promise((resolve) => {
        let settled = false;

        const proc = exec(
            config.buildCommand,
            { cwd: config.root, timeout: BUILD_TIMEOUT_MS },
            (error, stdout, stderr) => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);

                const output   = ((stdout || "") + "\n" + (stderr || "")).trim();
                const success  = !error;
                const exitCode = error?.code ?? 0;
                const prefix   = success ? "BUILD SUCCESS\n" : `BUILD FAILED (exit ${exitCode})\n`;

                if (!success) log.warn(`Build failed for "${project}": exit ${exitCode}`);

                resolve({
                    content: [{ type: "text", text: (prefix + output).substring(0, 8000) }],
                    success
                });
            }
        );

        // Belt-and-suspenders kill timer
        const killTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill("SIGTERM"); } catch { /* already exited */ }
            log.warn(`Build timeout for "${project}" after ${BUILD_TIMEOUT_MS / 1000}s`);
            resolve({
                content: [{ type: "text", text: `BUILD TIMEOUT after ${BUILD_TIMEOUT_MS / 1000}s — process killed.` }],
                success: false
            });
        }, BUILD_TIMEOUT_MS + 5000);
    });
}
