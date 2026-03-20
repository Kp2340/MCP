import fs from "fs";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";

/**
 * project_str_replace
 *
 * Applies targeted search-and-replace edits to project files instead of
 * rewriting entire files. Much safer and more token-efficient than
 * project_apply_changes for small modifications.
 *
 * Each edit:
 *   - finds the FIRST occurrence of `search` in the file
 *   - replaces it with `replace`
 *   - throws if `search` is not found (prevents silent no-ops)
 */
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

        const fullPath = validatePath(root, relativePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${relativePath}`);
        }

        const original = fs.readFileSync(fullPath, "utf8");

        if (!original.includes(search)) {
            throw new Error(
                `Search string not found in ${relativePath}.\n` +
                `Searched for: ${search.substring(0, 120)}`
            );
        }

        // Replace only the first occurrence — intentional, safer than replaceAll
        const updated = original.replace(search, replace);
        fs.writeFileSync(fullPath, updated, "utf8");
        results.push(`  edited: ${relativePath}`);
    }

    spawnSync("git", ["add", "."], { cwd: root });
    const safeMessage = sanitizeCommitMessage(commitMessage || "str-replace edit");
    spawnSync("git", ["commit", "-m", safeMessage], { cwd: root });

    return {
        content: [{
            type: "text",
            text: `str-replace applied:\n${results.join("\n")}`
        }]
    };
}
