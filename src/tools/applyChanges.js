import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

import { getProject } from "../core/projectRegistry.js";
import { validateChangeRequest, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";
import { findDependents } from "../analysis/symbolGraph.js";

const log = createLogger("apply-changes");

function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return (r.stdout || "").trim().length > 0;
}

function normalizeLF(content) {
    return content.replace(/\r/g, "\n");
}

export function applyChanges({ project, files, commitMessage }) {
    const config = getProject(project);
    const root = config.root;

    validateChangeRequest(files, root);

    for (const file of files) {
        const full = path.resolve(root, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });

        // 🔥 FORCE WRITE (critical fix)
        fs.writeFileSync(full, normalizeLF(file.content), "utf8");
    }

    spawnSync("git", ["add", "."], { cwd: root });

    if (!hasChanges(root)) {
        log.warn(`No changes detected — forcing commit anyway`);

        const safeMessage = sanitizeCommitMessage(commitMessage + " (force)");
        spawnSync("git", ["commit", "--allow-empty", "-m", safeMessage], { cwd: root });

        return {
            content: [{ type: "text", text: "Forced commit created (no diff detected)." }]
        };
    }

    const safeMessage = sanitizeCommitMessage(commitMessage);

    const result = spawnSync("git", ["commit", "-m", safeMessage], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Git commit failed: ${(result.stderr || result.stdout || "").trim()}`);
    }

    return {
        content: [{ type: "text", text: `Changes committed: ${safeMessage}` }]
    };
}
