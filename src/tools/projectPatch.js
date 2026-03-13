import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";
import { validatePath } from "../core/validator.js";

export function applyPatch({ project, patch }) {
    const root = getProject(project).root;

    // Validate patch content — block traversal and absolute paths
    if (patch.includes("../") || patch.includes("..\\")) {
        throw new Error("Unsafe patch: contains path traversal");
    }

    const patchPath = path.join(root, "_ai.patch");

    try {
        fs.writeFileSync(patchPath, patch, "utf8");

        // Use spawnSync with args array — handles paths with spaces on Windows
        const result = spawnSync("git", ["apply", patchPath], {
            cwd: root,
            encoding: "utf8"
        });

        if (result.status !== 0) {
            throw new Error(result.stderr || "git apply failed");
        }

        return {
            content: [{ type: "text", text: "Patch applied successfully" }]
        };

    } finally {
        // Always clean up the temp patch file
        try { fs.unlinkSync(patchPath); } catch {}
    }
}
