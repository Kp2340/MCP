import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("patch");

export function applyPatch({ project, patch }) {
    const root = getProject(project).root;

    // Security: reject patches containing path traversal sequences
    if (patch.includes("../") || patch.includes("..\\\\" )) {
        throw new Error("Unsafe patch: path traversal sequences are not allowed.");
    }

    if (!patch || patch.trim().length === 0) {
        throw new Error("Patch content is empty.");
    }

    const patchPath = path.join(root, ".ai-dev.patch");

    try {
        fs.writeFileSync(patchPath, patch, "utf8");

        // Use spawnSync instead of execSync — no shell, no injection risk
        const result = spawnSync(
            "git", ["apply", "--check", patchPath],
            { cwd: root, encoding: "utf8" }
        );

        if (result.status !== 0) {
            throw new Error(`Patch validation failed:\n${(result.stderr || result.stdout || "").trim()}`);
        }

        // Dry run passed — now actually apply
        const applyResult = spawnSync(
            "git", ["apply", patchPath],
            { cwd: root, encoding: "utf8" }
        );

        if (applyResult.status !== 0) {
            throw new Error(`Patch apply failed:\n${(applyResult.stderr || applyResult.stdout || "").trim()}`);
        }

        log.info(`Patch applied for "${project}"`);
        return { content: [{ type: "text", text: "Patch applied successfully." }] };

    } finally {
        // Always clean up the temp file
        try { fs.unlinkSync(patchPath); } catch { /* already removed */ }
    }
}
