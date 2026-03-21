import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("apply-changes");

function getNextBranch(root, prefix) {
    const result = spawnSync("git", ["branch"], { cwd: root, encoding: "utf8" });
    const branches = result.stdout || "";
    let max = 0;
    const regex = new RegExp(`${prefix}-(\\d+)`);
    branches.split("\n").forEach(b => {
        const clean = b.replace("*", "").trim();
        const m = clean.match(regex);
        if (m) {
            const n = parseInt(m[1]);
            if (n > max) max = n;
        }
    });
    return `${prefix}-${max + 1}`;
}

/** Returns true if git working tree has staged or unstaged changes. */
function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return (r.stdout || "").trim().length > 0;
}

export function applyChanges({ project, files, commitMessage, increment }) {
    const config = getProject(project);
    const root = config.root;

    validateChangeRequest(files, root);

    for (const file of files) {
        const full = path.resolve(root, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.content, "utf8");
    }

    spawnSync("git", ["add", "."], { cwd: root });

    // Guard: nothing to commit — skip silently instead of letting git error
    if (!hasChanges(root)) {
        log.warn(`applyChanges: no changes to commit for project "${project}"`);
        return {
            content: [{ type: "text", text: "No changes detected — files already match target content. Nothing committed." }]
        };
    }

    const safeMessage = sanitizeCommitMessage(commitMessage);

    if (increment) {
        const prefix = config.branchPrefix || "AI";
        const branch = getNextBranch(root, prefix);
        spawnSync("git", ["checkout", "-b", branch], { cwd: root });
        const result = spawnSync("git", ["commit", "-m", `${branch} ${safeMessage}`], { cwd: root, encoding: "utf8" });
        if (result.status !== 0) {
            throw new Error(`Git commit failed: ${(result.stderr || result.stdout || "").trim()}`);
        }
        return {
            content: [{ type: "text", text: `Created branch ${branch} and committed changes.` }]
        };
    }

    const result = spawnSync("git", ["commit", "-m", safeMessage], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Git commit failed: ${(result.stderr || result.stdout || "").trim()}`);
    }

    return {
        content: [{ type: "text", text: `Changes committed: ${safeMessage}` }]
    };
}
