import { execFileSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";

/**
 * project_search — ripgrep-based code search.
 *
 * Improvements:
 *   - Always ignores IGNORE_FOLDERS (node_modules, .git, dist, etc.)
 *   - Accepts optional `fileType` filter (e.g. "js", "ts", "java")
 *   - Returns structured output: file, line, match text
 *   - Caps at 30 matches with 300-char column limit
 */
export function searchProject({ project, query, fileType = null }) {
    const root = getProject(project).root;

    // Build rg ignore flags from IGNORE_FOLDERS
    const ignoreArgs = IGNORE_FOLDERS.flatMap(f => ["--glob", `!${f}/**`]);

    const typeArgs = fileType ? ["--type", fileType] : [];

    const args = [
        query,
        "-n",
        "--max-count",   "30",
        "--max-columns", "300",
        "--no-heading",
        "--with-filename",
        ...ignoreArgs,
        ...typeArgs
    ];

    try {
        const raw    = execFileSync("rg", args, { cwd: root }).toString();
        const lines  = raw.trim().split("\n").filter(Boolean);

        // Format: "file:line:match" — keep as-is, trim each line
        const output = lines.map(l => l.trim()).join("\n");

        return {
            content: [{ type: "text", text: output.substring(0, 5000) }]
        };
    } catch {
        return {
            content: [{ type: "text", text: `No results found for: ${query}` }]
        };
    }
}