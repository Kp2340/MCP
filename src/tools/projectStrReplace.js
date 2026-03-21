import fs from "fs";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("str-replace");

function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return (r.stdout || "").trim().length > 0;
}

/**
 * Normalize a string for comparison:
 * - Convert CRLF -> LF
 * - Do NOT trim — trimming causes false "not found" when search string
 *   starts or ends with meaningful whitespace/indentation.
 */
function normalize(s) {
    return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Escape all regex special characters so the search string is treated
 * as a literal string, not a pattern.
 * Root cause #3: search strings with () [] . * + ? ^ $ | \ were
 * interpreted as regex, causing unexpected matches or errors.
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function projectStrReplace({ project, edits, commitMessage }) {
    const config = getProject(project);
    const root   = config.root;

    // ── Git identity guard ──────────────────────────────────────────────────
    // Root cause #5: on fresh machines git user.email / user.name is not set,
    // causing "git commit" to fail silently with status 128.
    const emailCheck = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
    if (!emailCheck.stdout.trim()) {
        spawnSync("git", ["config", "user.email", "aidev@mcp.local"], { cwd: root });
        spawnSync("git", ["config", "user.name",  "AI Dev MCP"],       { cwd: root });
        log.info("Set fallback git identity for commit");
    }

    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must be a non-empty array");
    }

    const results = [];

    for (const edit of edits) {
        const { path: relativePath, search, replace } = edit;

        if (!relativePath || typeof search !== "string" || typeof replace !== "string") {
            throw new Error("Each edit must have path, search, and replace fields");
        }

        // ── Resolve file path ────────────────────────────────────────────────
        let fullPath = validatePath(root, relativePath);
        if (!fs.existsSync(fullPath)) {
            const searchDirs = ["src/components", "src/app", "src", "app", "components", "addons", "lib", "pkg"];
            let found = false;
            for (const dir of searchDirs) {
                try {
                    const candidate = validatePath(root, `${dir}/${relativePath}`);
                    if (fs.existsSync(candidate)) { fullPath = candidate; found = true; break; }
                } catch { /* invalid — skip */ }
            }
            if (!found) {
                throw new Error(
                    `File not found: "${relativePath}".\n` +
                    `Tip: use the relative path from the project root, e.g. "src/utils/auth.js"`
                );
            }
        }

        const rawOriginal = fs.readFileSync(fullPath, "utf8");

        // ── Root cause #1: CRLF + .trim() mismatch ──────────────────────────
        // Previous code called .trim() on the search string. This stripped
        // leading/trailing newlines that are part of the actual content,
        // so the search string never matched even though it was "correct".
        // Fix: normalize line endings only, never trim.
        const normalizedFile   = normalize(rawOriginal);
        const normalizedSearch  = normalize(search);   // NO .trim()
        const normalizedReplace = normalize(replace);

        // ── Root cause #2: search string not in file ─────────────────────────
        // Better diagnostic: show surrounding context so user can fix the prompt.
        if (!normalizedFile.includes(normalizedSearch)) {
            // Find closest partial match for helpful hint
            const searchLines  = normalizedSearch.split("\n");
            const firstLine    = searchLines[0].trim();
            const hintIdx      = normalizedFile.indexOf(firstLine);
            const hint = hintIdx !== -1
                ? `\nClosest match found at char ${hintIdx}: "${normalizedFile.slice(hintIdx, hintIdx + 80).replace(/\n/g, "↵")}"`
                : "\nNo partial match found — the file may have changed since it was read.";

            throw new Error(
                `Search string not found in "${relativePath}".\n` +
                `Searched (first 150 chars): "${search.slice(0, 150).replace(/\n/g, "↵")}"` +
                hint +
                `\nTip: call project_read_files first to get the exact current content.`
            );
        }

        // ── Root cause #3: regex special chars + root cause #4: ambiguous match
        // String.replace(string, replacement) only replaces the FIRST occurrence.
        // If the search matches more than once, the edit is ambiguous — throw.
        const escapedSearch = escapeRegex(normalizedSearch);
        const matchCount    = (normalizedFile.match(new RegExp(escapedSearch, "g")) || []).length;
        if (matchCount > 1) {
            throw new Error(
                `Ambiguous edit: search string appears ${matchCount} times in "${relativePath}".\n` +
                `Make the search string longer/more specific so it matches exactly once.`
            );
        }

        const updated = normalizedFile.replace(normalizedSearch, normalizedReplace);
        fs.writeFileSync(fullPath, updated, "utf8");
        log.info(`str-replace: edited ${relativePath}`);
        results.push(`  edited: ${relativePath}`);
    }

    spawnSync("git", ["add", "."], { cwd: root });

    if (!hasChanges(root)) {
        log.warn(`str-replace: no net changes — files already match target`);
        return {
            content: [{ type: "text", text: `str-replace applied (no net change):\n${results.join("\n")}` }]
        };
    }

    const safeMessage = sanitizeCommitMessage(commitMessage || "str-replace edit");
    const result = spawnSync("git", ["commit", "-m", safeMessage], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Git commit failed: ${(result.stderr || result.stdout || "").trim()}`);
    }

    return {
        content: [{ type: "text", text: `str-replace applied:\n${results.join("\n")}` }]
    };
}
