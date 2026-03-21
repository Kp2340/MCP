/**
 * project_diff — Show uncommitted changes as a git diff.
 *
 * New tool: lets the agent inspect exactly what it has changed
 * before committing, enabling pre-commit review and targeted fixes.
 *
 * Returns:
 *   - Unified diff of all unstaged + staged changes
 *   - Summary line counts (files changed, insertions, deletions)
 *   - Capped at 6000 chars to avoid flooding agent context
 */

import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";

export function projectDiff({ project, staged = false }) {
    const config = getProject(project);
    const root   = config.root;

    // Get unified diff
    const diffArgs = staged
        ? ["diff", "--cached", "--unified=3"]
        : ["diff", "HEAD", "--unified=3"];

    const diffResult = spawnSync("git", diffArgs, { cwd: root, encoding: "utf8" });
    const diff       = (diffResult.stdout || "").trim();

    // Get short stat summary
    const statArgs   = staged
        ? ["diff", "--cached", "--stat"]
        : ["diff", "HEAD", "--stat"];
    const statResult = spawnSync("git", statArgs, { cwd: root, encoding: "utf8" });
    const stat       = (statResult.stdout || "").trim();

    if (!diff && !stat) {
        return {
            content: [{ type: "text", text: "No changes detected (working tree is clean)." }]
        };
    }

    const output = [
        stat ? `Summary:\n${stat}` : "",
        diff ? `\nDiff:\n${diff.substring(0, 5500)}` : ""
    ].filter(Boolean).join("\n");

    return {
        content: [{ type: "text", text: output }]
    };
}
