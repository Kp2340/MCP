import fs from "fs";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("str-replace");

/** Returns true if git working tree has staged or unstaged changes. */
function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return (r.stdout || "").trim().length > 0;
}

export function projectStrReplace({ project, edits, commitMessage }) {
    const config = getProject(project);
    const root = config.root;

    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must be a non-empty array");
    }

    const results = [];

    for (const edit of edits) {
        const { path: relativePath, search, replace } = edit;

        if (!relativePath || typeof search !== "string" || typeof replace !== "string") {
            throw new Error("Each edit must have path, search, and replace fields");
        }

        // Resolve path — try direct first, then common subdirs
        let fullPath = validatePath(root, relativePath);
        if (!fs.existsSync(fullPath)) {
            const searchDirs = ["src/components", "src/app", "src", "app", "components", "addons"];
            let found = false;
            for (const dir of searchDirs) {
                try {
                    const candidate = validatePath(root, `${dir}/${relativePath}`);
                    if (fs.existsSync(candidate)) {
                        fullPath = candidate;
                        found = true;
                        break;
                    }
                } catch { /* invalid path — skip */ }
            }
            if (!found) throw new Error(`File not found: ${relativePath}`);
        }

        const original = fs.readFileSync(fullPath, "utf8");

        // Normalize line endings — LLM returns LF, files may have CRLF
        const normalizedOriginal = original.replace(/\r\n/g, "\n");
        const normalizedSearch   = search.replace(/\r\n/g, "\n").trim();
        const normalizedReplace  = replace.replace(/\r\n/g, "\n");

        if (!normalizedOriginal.includes(normalizedSearch)) {
            throw new Error(
                `Search string not found in ${relativePath}.\n` +
                `Searched for: ${search.substring(0, 120)}`
            );
        }

        const updated = normalizedOriginal.replace(normalizedSearch, normalizedReplace);
        fs.writeFileSync(fullPath, updated, "utf8");
        results.push(`  edited: ${relativePath}`);
    }

    spawnSync("git", ["add", "."], { cwd: root });

    // Guard: nothing to commit
    if (!hasChanges(root)) {
        log.warn(`str-replace: no net changes to commit for project "${project}"`);
        return {
            content: [{ type: "text", text: `str-replace applied (no net change — file content identical):\n${results.join("\n")}` }]
        };
    }

    const safeMessage = sanitizeCommitMessage(commitMessage || "str-replace edit");
    const result = spawnSync("git", ["commit", "-m", safeMessage], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Git commit failed: ${(result.stderr || result.stdout || "").trim()}`);
    }

    return {
        content: [{
            type: "text",
            text: `str-replace applied:\n${results.join("\n")}`
        }]
    };
}
