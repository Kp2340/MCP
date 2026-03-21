import fs from "fs";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";

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

        let fullPath = validatePath(root, relativePath);

        if (!fs.existsSync(fullPath)) {
            const searchDirs = ["src/components", "src/app", "src", "app", "components"];
            let found = false;
            for (const dir of searchDirs) {
                try {
                    const candidate = validatePath(root, `${dir}/${relativePath}`);
                    if (fs.existsSync(candidate)) {
                        fullPath = candidate;
                        found = true;
                        break;
                    }
                } catch { /* invalid path - skip */ }
            }
            if (!found) throw new Error(`File not found: ${relativePath}`);
        }

        const original = fs.readFileSync(fullPath, "utf8");

        // Normalize line endings for comparison — LLM returns LF, files may have CRLF
        const normalizedOriginal = original.replace(/\r\n/g, "\n");
        const normalizedSearch   = search.replace(/\r\n/g, "\n").trim();
        const normalizedReplace  = replace.replace(/\r\n/g, "\n");

        if (!normalizedOriginal.includes(normalizedSearch)) {
            throw new Error(
                `Search string not found in ${relativePath}.\n` +
                `Searched for: ${search.substring(0, 120)}`
            );
        }

        // Replace in normalized content
        const updated = normalizedOriginal.replace(normalizedSearch, normalizedReplace);
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
