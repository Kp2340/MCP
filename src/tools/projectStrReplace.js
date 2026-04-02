import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";
import { findDependents } from "../analysis/symbolGraph.js";

const log = createLogger("str-replace");

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_EDITS_PER_CALL   = 20;
const MAX_IMPACT_DISPLAYED = 8;
const SEARCH_DIRS = [
    "src/components", "src/app", "src", "app",
    "components", "addons", "lib", "pkg",
];

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalize a string for comparison without destroying code content.
 *
 * - CRLF / bare CR  → LF           (line-ending portability)
 * - JSON-escaped \n → real newline  (LLM often emits \n literally)
 * - JSON-escaped \t → real tab      (same reason)
 *
 * NOT trimmed — leading/trailing whitespace is meaningful in code.
 * NOT collapsed — collapsing spaces would destroy indentation.
 */
function normalize(s) {
    return s
        .replace(/\r\n/g, "\n")   // CRLF → LF
        .replace(/\r/g,   "\n")   // bare CR → LF
        .replace(/\\n/g,  "\n")   // JSON-escaped newline → real newline
        .replace(/\\t/g,  "\t");  // JSON-escaped tab → real tab
}

/**
 * Escape all regex metacharacters so a search string is treated literally.
 *
 * Without this, search strings containing . ( ) [ ] * + ? ^ $ | \ would
 * either throw or produce unexpected matches.
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

/**
 * Fuzzy line-by-line match fallback.
 *
 * When exact string match fails (e.g. LLM generated search from truncated
 * context), try to find the search block by matching its non-empty lines as a
 * contiguous sequence inside the file.  Returns the exact substring from the
 * file if found, null otherwise.
 *
 * Recovers from:
 *  - Leading/trailing whitespace differences per line
 *  - Single-line truncation at the boundary of the 4 K context window
 *  - Minor LLM whitespace paraphrasing
 *
 * Deliberately restricted to multi-line searches — single-line fuzzy matches
 * produce too many false positives.
 */
function fuzzyLineMatch(fileContent, searchStr) {
    const fileLines   = fileContent.split("\n");
    const searchLines = searchStr
        .split("\n")
        .map(l => l.trimEnd())
        .filter(l => l.trim().length > 0);

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
            return fileLines.slice(i, i + searchLines.length).join("\n");
        }
    }
    return null;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], {
        cwd: root, encoding: "utf8",
    });
    return (r.stdout || "").trim().length > 0;
}

/**
 * Ensure git user identity is configured so commits don't fail on fresh
 * machines.  Checks local repo config first, then global — only injects a
 * fallback if both are empty, so the developer's real identity is never
 * overwritten.
 */
function ensureGitIdentity(root) {
    const get = (scope, key) =>
        spawnSync("git", ["config", scope, key], { cwd: root, encoding: "utf8" }).stdout.trim();

    if (!get("--local", "user.email") && !get("--global", "user.email")) {
        spawnSync("git", ["config", "user.email", "aidev@mcp.local"], { cwd: root });
        spawnSync("git", ["config", "user.name",  "AI Dev MCP"],       { cwd: root });
        log.info("Set fallback git identity for commit");
    }
}

/**
 * Stage all changes and commit.  Returns the git output on success.
 * Throws a descriptive Error on failure so callers can surface it cleanly.
 */
function commitChanges(root, message) {
    spawnSync("git", ["add", "."], { cwd: root });

    const safeMessage = sanitizeCommitMessage(message || "str-replace edit");
    const result = spawnSync("git", ["commit", "-m", safeMessage], {
        cwd: root, encoding: "utf8",
    });

    if (result.status !== 0) {
        throw new Error(
            `Git commit failed: ${(result.stderr || result.stdout || "").trim()}`,
        );
    }

    return result.stdout.trim();
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a relative path to an absolute path, searching common source
 * directories when the path doesn't exist at the root.
 *
 * Throws a descriptive Error (not a raw path) when the file cannot be found,
 * so the LLM agent gets an actionable message.
 */
function resolveFilePath(root, relativePath) {
    // Reject obviously dangerous inputs before even calling validatePath.
    if (!relativePath || typeof relativePath !== "string") {
        throw new Error("edit.path must be a non-empty string");
    }

    // Block absolute paths — they bypass the project root sandbox.
    if (path.isAbsolute(relativePath)) {
        throw new Error(
            `Absolute paths are not allowed: "${relativePath}". ` +
            `Use a path relative to the project root.`,
        );
    }

    // Direct match
    try {
        const fullPath = validatePath(root, relativePath);
        if (fs.existsSync(fullPath)) return fullPath;
    } catch { /* path traversal attempt — fall through to give cleaner error */ }

    // Search common source directories
    for (const dir of SEARCH_DIRS) {
        try {
            const candidate = validatePath(root, `${dir}/${relativePath}`);
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* invalid path — skip */ }
    }

    throw new Error(
        `File not found: "${relativePath}".\n` +
        `Tip: use the relative path from the project root, e.g. "src/utils/auth.js"`,
    );
}

// ── Edit validation ───────────────────────────────────────────────────────────

/**
 * Validate a single edit object's shape before any filesystem work.
 * Throws early with a clear message so callers don't waste I/O on bad input.
 */
function validateEdit(edit, index) {
    if (!edit || typeof edit !== "object") {
        throw new Error(`edits[${index}] must be an object`);
    }
    const { path: p, search, replace } = edit;
    if (!p || typeof p !== "string")       throw new Error(`edits[${index}].path must be a non-empty string`);
    if (typeof search  !== "string")       throw new Error(`edits[${index}].search must be a string`);
    if (typeof replace !== "string")       throw new Error(`edits[${index}].replace must be a string`);
    if (search.trim().length === 0)        throw new Error(`edits[${index}].search must not be empty`);
}

// ── Rich diagnostic ───────────────────────────────────────────────────────────

/**
 * Build a rich diagnostic error message for the LLM agent when neither exact
 * nor fuzzy search succeeds.  The hint shows where the first search line was
 * found in the file so the agent can re-anchor its search string.
 */
function buildNotFoundError(relativePath, search, normalizedFile, normalizedSearch) {
    const searchLines = normalizedSearch.split("\n");
    const firstLine   = searchLines[0].trim();
    const hintIdx     = normalizedFile.indexOf(firstLine);

    const hint = hintIdx !== -1
        ? `\nFirst line found at char ${hintIdx}: ` +
        `"${normalizedFile.slice(hintIdx, hintIdx + 120).replace(/\n/g, "↵")}"`
        : "No partial match found — the file may have changed since it was read.";

    return new Error(
        `Search string not found in "${relativePath}".\n` +
        `Searched (first 150 chars): "${search.slice(0, 150).replace(/\n/g, "↵")}"` +
        hint +
        `\nFix: call project_read_files on "${relativePath}" to get current content, then retry str_replace.`,
    );
}

// ── Impact analysis ───────────────────────────────────────────────────────────

/**
 * Collect all files that import any of the edited files (up to depth 2).
 * Returns an array of formatted strings for the result message.
 * Never throws — impact analysis is best-effort and must not block a commit.
 */
function computeImpact(project, editedPaths) {
    try {
        const normalised  = editedPaths.map(p => p.replace(/\\/g, "/"));
        const allAffected = new Set();

        for (const file of normalised) {
            findDependents(project, file, 2).forEach(f => allAffected.add(f));
        }
        // Remove the files we just edited
        normalised.forEach(f => allAffected.delete(f));

        if (allAffected.size === 0) return [];

        const lines = ["\nImpact analysis — files that import the edited file(s):"];
        [...allAffected]
            .slice(0, MAX_IMPACT_DISPLAYED)
            .forEach(f => lines.push(`  - ${f}`));

        if (allAffected.size > MAX_IMPACT_DISPLAYED) {
            lines.push(`  ... and ${allAffected.size - MAX_IMPACT_DISPLAYED} more`);
        }

        log.info(`Impact: ${allAffected.size} file(s) import edited file(s)`);
        return lines;
    } catch (err) {
        log.warn(`Impact analysis skipped: ${err.message}`);
        return [];
    }
}

// ── Core single-edit applier ──────────────────────────────────────────────────

/**
 * Apply one edit to one file in-memory.
 *
 * Returns the updated file content as a string (caller is responsible for
 * writing to disk).  This keeps the function pure and easily testable.
 *
 * Throws descriptive Errors for:
 *  - Search string not found (after fuzzy fallback)
 *  - Ambiguous search string (matches > 1 location)
 */
function applyEditInMemory(relativePath, rawOriginal, search, replace) {
    const normalizedFile    = normalize(rawOriginal);
    const normalizedSearch  = normalize(search);
    const normalizedReplace = normalize(replace);

    // ── Find the search string ────────────────────────────────────────────
    let effectiveSearch = normalizedSearch;

    if (!normalizedFile.includes(normalizedSearch)) {
        const fuzzyMatch = fuzzyLineMatch(normalizedFile, normalizedSearch);
        if (fuzzyMatch) {
            log.info(`str-replace: exact match failed, fuzzy match succeeded for ${relativePath}`);
            effectiveSearch = fuzzyMatch;
        } else {
            throw buildNotFoundError(relativePath, search, normalizedFile, normalizedSearch);
        }
    }

    // ── Ambiguity check ───────────────────────────────────────────────────
    const matchCount = (normalizedFile.match(new RegExp(escapeRegex(effectiveSearch), "g")) || []).length;
    if (matchCount > 1) {
        throw new Error(
            `Ambiguous edit: search string appears ${matchCount} times in "${relativePath}".\n` +
            `Make the search string longer/more specific so it matches exactly once.`,
        );
    }

    // ── Apply replacement, always write LF-only ───────────────────────────
    return normalizedFile
        .replace(effectiveSearch, normalizedReplace)
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function projectStrReplace({ project, edits, commitMessage }) {
    // ── Input validation ──────────────────────────────────────────────────
    if (!project || typeof project !== "string") {
        throw new Error("project must be a non-empty string");
    }
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must be a non-empty array");
    }
    if (edits.length > MAX_EDITS_PER_CALL) {
        throw new Error(
            `Too many edits in one call (${edits.length}). ` +
            `Maximum is ${MAX_EDITS_PER_CALL}. Split into multiple calls.`,
        );
    }

    edits.forEach(validateEdit);

    // ── Project setup ─────────────────────────────────────────────────────
    const config = getProject(project);
    const root   = config.root;

    ensureGitIdentity(root);

    // ── Apply all edits (collect results before any disk write) ───────────
    // We resolve paths and compute updated content for ALL edits before
    // writing anything.  This way, a bad search string on edit #3 won't
    // leave the repo in a half-modified state.
    const pendingWrites = [];

    for (let i = 0; i < edits.length; i++) {
        const { path: relativePath, search, replace } = edits[i];

        const fullPath   = resolveFilePath(root, relativePath);
        const rawContent = fs.readFileSync(fullPath, "utf8");
        const updated    = applyEditInMemory(relativePath, rawContent, search, replace);

        pendingWrites.push({ fullPath, relativePath, updated });
    }

    // ── All edits validated — now write to disk ───────────────────────────
    const results = [];
    for (const { fullPath, relativePath, updated } of pendingWrites) {
        fs.writeFileSync(fullPath, updated, "utf8");
        log.info(`str-replace: edited ${relativePath}`);
        results.push(`  edited: ${relativePath}`);
    }

    // ── Commit ────────────────────────────────────────────────────────────
    if (!hasChanges(root)) {
        log.warn("str-replace: no net changes — files already match target");
        return {
            content: [{
                type: "text",
                text: `str-replace applied (no net change):\n${results.join("\n")}`,
            }],
        };
    }

    commitChanges(root, commitMessage);

    // ── Impact analysis ───────────────────────────────────────────────────
    const editedPaths  = edits.map(e => e.path);
    const impactLines  = computeImpact(project, editedPaths);

    return {
        content: [{
            type: "text",
            text: `str-replace applied:\n${results.join("\n")}${impactLines.join("\n")}`,
        }],
    };
}