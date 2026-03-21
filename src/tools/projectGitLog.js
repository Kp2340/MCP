/**
 * project_git_log — Show recent git commit history.
 *
 * New tool: gives the agent awareness of what has already been committed
 * in this session, preventing duplicate commits and helping it understand
 * what state the codebase is currently in.
 *
 * Returns last N commits (default 10) with:
 *   - Short hash
 *   - Author date
 *   - Commit message
 */

import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";

export function projectGitLog({ project, count = 10 }) {
    const config = getProject(project);
    const root   = config.root;

    const result = spawnSync(
        "git",
        ["log", `--max-count=${Math.min(count, 30)}`, "--oneline", "--no-decorate"],
        { cwd: root, encoding: "utf8" }
    );

    const log = (result.stdout || "").trim();

    if (!log) {
        return {
            content: [{ type: "text", text: "No commits found." }]
        };
    }

    return {
        content: [{ type: "text", text: log }]
    };
}
