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
 * Normalize a string for comparison.
 * - Convert CRLF -> LF
 * - Convert JSON-escaped newlines (\\n from LLM output) -> real newlines
 * - Convert JSON-escaped tabs (\\t) -> real tabs
 * - Do NOT trim — trimming causes false "not found" when search string
 *   starts or ends with meaningful whitespace/indentation.
 */
function normalize(s) {
    return s
        .replace(/\r\n/g, "\n")  // Windows CRLF
        .replace(/\r/g, "\n")    // old Mac CR
        .replace(/\\n/g, "\n")   // JSON-escaped newline from LLM
        .replace(/\\t/g, "\t");  // JSON-escaped tab from LLM
}

/**
 * Fuzzy line-by-line match fallback.
 *
 * When exact string match fails (e.g. LLM generated search from truncated context),
 * try to find the search block by matching its non-empty lines as a contiguous
 * sequence inside the file. Returns the exact substring from the file if found,
 * null otherwise.
 *
 * This recovers from:
 *  - Leading/trailing whitespace differences
 *  - Single-line truncation at the boundary of the 4K context window
 *  - Minor LLM paraphrasing of whitespace
 */
function fuzzyLineMatch(fileContent, searchStr) {
    const fileLines   = fileContent.split("\n");
    const searchLines = searchStr.split("\n").map(l => l.trimEnd()).filter(l => l.trim().length > 0);

    if (searchLines.length === 0) return null;
    // Only attempt fuzzy match for multi-line searches (single-line false positives are too risky)
    if (searchLines.length < 2) return null;

    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let matched = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (fileLines[i + j].trimEnd() !== searchLines[j]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            // Return the exact slice from the file (preserves original whitespace/endings)
            const startLine = i;
            const endLine   = i + searchLines.length - 1;
            return fileLines.slice(startLine, endLine + 1).join("\n");
        }
    }
    return null;
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
    // On fresh machines git user.email/user.name may not be configured,
    // causing "git commit" to fail with exit code 128.
    // Check local repo config first, then global — only inject fallback if BOTH empty.
    // This avoids overwriting the developer's real global git identity.
    const localEmail  = spawnSync("git", ["config", "--local",  "user.email"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const globalEmail = spawnSync("git", ["config", "--global", "user.email"], { cwd: root, encoding: "utf8" }).stdout.trim();
    if (!localEmail && !globalEmail) {
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

        // ── Search string not found — try fuzzy fallback before giving up ────
        let effectiveSearch = normalizedSearch;
        if (!normalizedFile.includes(normalizedSearch)) {
            // Attempt fuzzy line-by-line match (recovers from truncation / whitespace drift)
            const fuzzyMatch = fuzzyLineMatch(normalizedFile, normalizedSearch);
            if (fuzzyMatch) {
                log.info(`str-replace: exact match failed, fuzzy match succeeded for ${relativePath}`);
                effectiveSearch = fuzzyMatch;
            } else {
                // Both exact and fuzzy failed — give rich diagnostic for LLM retry
                const searchLines  = normalizedSearch.split("\n");
                const firstLine    = searchLines[0].trim();
                const hintIdx      = normalizedFile.indexOf(firstLine);
                const hint = hintIdx !== -1
                    ? `\nFirst line found at char ${hintIdx}: "${normalizedFile.slice(hintIdx, hintIdx + 120).replace(/\n/g, "↵")}"`
                    : "\nNo partial match found — the file may have changed since it was read.";

                throw new Error(
                    `Search string not found in "${relativePath}".\n` +
                    `Searched (first 150 chars): "${search.slice(0, 150).replace(/\n/g, "↵")}"` +
                    hint +
                    `\nFix: call project_read_files on "${relativePath}" to get current content, then retry str_replace.`
                );
            }
        }

        // Ambiguous match check: effectiveSearch must appear exactly once
        const escapedSearch = escapeRegex(effectiveSearch);
        const matchCount    = (normalizedFile.match(new RegExp(escapedSearch, "g")) || []).length;
        if (matchCount > 1) {
            throw new Error(
                `Ambiguous edit: search string appears ${matchCount} times in "${relativePath}".\n` +
                `Make the search string longer/more specific so it matches exactly once.`
            );
        }

        // Apply: use effectiveSearch (may be fuzzy-resolved) for the actual replace
        const updated = normalizedFile.replace(effectiveSearch, normalizedReplace);
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
