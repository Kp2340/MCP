/**
 * src/agent/agentRunner.js
 *
 * Wrapper that exports runAgent for use by the HTTP job queue.
 *
 * MCP-3.11 improvements:
 *   - Project name extracted here so both the agent AND the registry get
 *     the clean name (not the full path string if a path was passed).
 *   - Handles absolute paths passed as project — strips to base name and
 *     auto-registers if needed before calling runAgent.
 *   - Wraps runAgent errors to include the project name for better diagnostics.
 */

import path from "path";
import fs   from "fs";
import { registerDynamicProject, listProjects } from "../core/projectRegistry.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("agent-runner");

export async function runAgent(prompt, emit = null) {
    // Dynamic import to avoid circular dep issues at startup
    const { runAgent: _run } = await import("./agent.js");

    // Extract project from prompt — supports:
    //   project: my-project
    //   project: C:/Projects/odoo
    //   project: /home/user/myapp
    const projectMatch = prompt.match(/project:\s*([^\s]+(?:\s+[^\s]+)*?)(?:\s+project:|$)/i)
        || prompt.match(/project:\s*(.*)/i);

    if (!projectMatch) {
        throw new Error("Prompt must include: project: <name-or-path>");
    }

    const rawProject = projectMatch[1].trim();

    // If rawProject looks like a filesystem path, auto-register it
    const isPath =
        path.isAbsolute(rawProject) ||
        rawProject.startsWith("./") ||
        rawProject.startsWith("../") ||
        (process.platform === "win32" && /^[A-Za-z]:[/\\]/.test(rawProject));

    let projectName = rawProject;

    if (isPath) {
        if (!fs.existsSync(rawProject)) {
            throw new Error(`Project path does not exist: "${rawProject}"`);
        }
        projectName = path.basename(rawProject)
            .replace(/[^a-zA-Z0-9-_]/g, "-")
            .toLowerCase();

        const known = listProjects();
        if (!known.includes(projectName)) {
            registerDynamicProject(projectName, rawProject);
            log.info(`Auto-registered "${projectName}" from path "${rawProject}"`);
        }

        // Rewrite prompt to use the clean project name
        prompt = prompt.replace(rawProject, projectName);
    }

    log.info(`Running agent | project=${projectName}`);

    try {
        await _run(prompt, emit);
    } catch (err) {
        log.error(`Agent failed | project=${projectName} | ${err.message}`);
        throw err;
    }
}
