/**
 * src/git/checkpoint.js
 *
 * Creates a git stash checkpoint before any agent run that modifies files.
 * This gives the user a guaranteed rollback point beyond just the last commit.
 *
 * Usage:
 *   const cp = await createCheckpoint(projectRoot, "before agent run");
 *   // ... agent runs ...
 *   await restoreCheckpoint(cp);   // undo everything (optional)
 *   // or just leave it — stash stays until manually dropped
 */

import { spawnSync } from "child_process";
import { createLogger } from "../core/logger.js";

const log = createLogger("checkpoint");

/**
 * Create a git stash checkpoint.
 * Only stashes if there are uncommitted changes — clean repos are skipped.
 *
 * @param {string} root    - absolute project root path
 * @param {string} message - stash description
 * @returns {{ stashed: boolean, ref: string|null }}
 */
export function createCheckpoint(root, message = "ai-dev-mcp checkpoint") {
    // Check for uncommitted changes first
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
    const hasChanges = (status.stdout || "").trim().length > 0;

    if (!hasChanges) {
        log.info("Checkpoint: working tree clean — skipping stash");
        return { stashed: false, ref: null };
    }

    const result = spawnSync(
        "git", ["stash", "push", "-m", message, "--include-untracked"],
        { cwd: root, encoding: "utf-8" }
    );

    if (result.status !== 0) {
        log.warn(`Checkpoint stash failed: ${result.stderr || "unknown error"}`);
        return { stashed: false, ref: null };
    }

    // Get the stash ref (stash@{0})
    const listResult = spawnSync("git", ["stash", "list", "--max-count=1"], { cwd: root, encoding: "utf-8" });
    const ref = listResult.stdout?.trim().split(":")?.[0] || "stash@{0}";

    log.info(`Checkpoint created: ${ref} — "${message}"`);
    return { stashed: true, ref };
}

/**
 * Restore (pop) the most recent checkpoint stash.
 * Call this only if you want to fully undo what the agent did.
 *
 * @param {string} root
 * @param {string} ref  - stash ref from createCheckpoint
 */
export function restoreCheckpoint(root, ref = "stash@{0}") {
    const result = spawnSync("git", ["stash", "pop", ref], { cwd: root, encoding: "utf-8" });
    if (result.status !== 0) {
        log.warn(`Checkpoint restore failed: ${result.stderr}`);
        return false;
    }
    log.info(`Checkpoint restored: ${ref}`);
    return true;
}

/**
 * Drop (discard) a checkpoint stash — call when agent succeeded and user accepted.
 *
 * @param {string} root
 * @param {string} ref
 */
export function dropCheckpoint(root, ref = "stash@{0}") {
    spawnSync("git", ["stash", "drop", ref], { cwd: root, encoding: "utf-8" });
    log.info(`Checkpoint dropped: ${ref}`);
}
