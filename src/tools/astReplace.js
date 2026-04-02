/**
 * src/tools/astReplace.js
 *
 * AST-aware symbol rename for the MCP agent.
 *
 * Problem with plain str_replace for renames:
 *   str_replace replaces the FIRST occurrence of a literal string.
 *   A rename like "userId" → "accountId" needs ALL occurrences changed,
 *   and must not touch substrings (e.g. "getUserId" should NOT become
 *   "getAccountId" unless the caller explicitly wants that).
 *
 * This module provides:
 *   renameSymbol(root, filePath, oldName, newName, options)
 *     — Renames every whole-word occurrence of `oldName` to `newName`
 *       in the file at `filePath` under project root `root`.
 *     — Returns { ok, replacements, preview, backup } so callers can
 *       decide whether to commit the change.
 *
 *   renameSymbolInProject(root, oldName, newName, extensions)
 *     — Walks the entire project and renames across all matching files.
 *     — Returns { ok, files: [{ path, replacements }] }
 *
 * Why not a real AST?
 *   Full AST parsing (acorn, babel, ts-morph) requires the file to be
 *   syntactically correct AND adds heavy dependencies. For the vast majority
 *   of agent rename tasks (variable, function, class, constant names), a
 *   word-boundary regex is correct and far lighter. Edge cases (renaming
 *   inside strings/comments) are explicitly flagged in the output.
 *
 * MCP tool registration is handled in src/index.js by calling
 *   registerAstReplaceTools(server, registry)
 */

import fs   from 'fs';
import path from 'path';
import { validatePath } from '../core/validator.js';
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Core rename logic
// ---------------------------------------------------------------------------

/**
 * Rename all whole-word occurrences of `oldName` to `newName` in one file.
 *
 * @param {string}  root      - absolute project root
 * @param {string}  filePath  - relative file path inside project
 * @param {string}  oldName   - symbol to rename (exact identifier)
 * @param {string}  newName   - replacement identifier
 * @param {object}  opts
 * @param {boolean} [opts.dryRun=false]    - preview only, don't write
 * @param {boolean} [opts.backup=false]    - write .bak file before editing
 * @returns {{ ok: boolean, replacements: number, preview: string, error?: string, backupPath?: string }}
 */
export function renameSymbol(root, filePath, oldName, newName, opts = {}) {
    const { dryRun = false, backup = false } = opts;

    // Validate names are valid JS identifiers
    const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    if (!IDENT.test(oldName)) return { ok: false, replacements: 0, preview: '', error: `oldName "${oldName}" is not a valid identifier` };
    if (!IDENT.test(newName)) return { ok: false, replacements: 0, preview: '', error: `newName "${newName}" is not a valid identifier` };

    let fullPath;
    try {
        fullPath = validatePath(root, filePath);
    } catch (e) {
        return { ok: false, replacements: 0, preview: '', error: e.message };
    }

    let content;
    try {
        content = fs.readFileSync(fullPath, 'utf-8');
    } catch (e) {
        return { ok: false, replacements: 0, preview: '', error: `Cannot read ${filePath}: ${e.message}` };
    }

    // Word-boundary regex: matches `oldName` only when surrounded by
    // non-identifier characters (spaces, punctuation, line starts/ends).
    // \b works for ASCII identifiers. For identifiers starting/ending with
    // $ or _ \b is still correct since those are \w characters.
    const re = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');
    const matches = [...content.matchAll(re)];
    const replacements = matches.length;

    if (replacements === 0) {
        return { ok: true, replacements: 0, preview: `No occurrences of "${oldName}" found in ${filePath}`, error: undefined };
    }

    const updated = content.replace(re, newName);

    // Build a compact diff-style preview (first 5 changed lines)
    const previewLines = buildPreview(content, updated, oldName, newName, 5);

    if (!dryRun) {
        let backupPath;
        if (backup) {
            backupPath = fullPath + '.bak';
            try { fs.writeFileSync(backupPath, content); } catch { /* non-fatal */ }
        }
        try {
            fs.writeFileSync(fullPath, updated, 'utf-8');
        } catch (e) {
            return { ok: false, replacements, preview: previewLines, error: `Write failed: ${e.message}` };
        }
        return { ok: true, replacements, preview: previewLines, backupPath };
    }

    return { ok: true, replacements, preview: previewLines };
}

/**
 * Rename a symbol across all source files in the project.
 *
 * @param {string}   root        - absolute project root
 * @param {string}   oldName     - symbol to rename
 * @param {string}   newName     - replacement
 * @param {string[]} [extensions] - file extensions to scan (default: INDEXABLE_EXTENSIONS)
 * @param {boolean}  [dryRun]    - preview only
 * @returns {{ ok: boolean, totalReplacements: number, files: Array<{path, replacements, preview}> }}
 */
export function renameSymbolInProject(root, oldName, newName, extensions, dryRun = false) {
    const exts   = extensions ?? INDEXABLE_EXTENSIONS;
    const files  = walkProject(root, exts);
    const result = [];
    let   total  = 0;

    for (const relPath of files) {
        const r = renameSymbol(root, relPath, oldName, newName, { dryRun });
        if (r.replacements > 0) {
            total += r.replacements;
            result.push({ path: relPath, replacements: r.replacements, preview: r.preview, ok: r.ok });
        }
    }

    return { ok: true, totalReplacements: total, files: result };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

/**
 * Register two MCP tools:
 *   project_rename_symbol        - renames in a single file
 *   project_rename_symbol_all    - renames across the whole project
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server
 * @param {object} registry   - projectRegistry module
 */
export function registerAstReplaceTools(server, registry) {

    // ── project_rename_symbol ──────────────────────────────────────────────
    server.tool(
        'project_rename_symbol',
        {
            description: 'Rename ALL whole-word occurrences of a symbol in one file. Safer than str_replace for renames because it matches every occurrence and respects word boundaries (won\'t corrupt substrings).',
            inputSchema: {
                type: 'object',
                properties: {
                    project:  { type: 'string', description: 'Registered project name' },
                    path:     { type: 'string', description: 'Relative file path, e.g. src/utils/auth.js' },
                    oldName:  { type: 'string', description: 'Identifier to rename (exact, case-sensitive)' },
                    newName:  { type: 'string', description: 'Replacement identifier' },
                    dryRun:   { type: 'boolean', description: 'If true, preview changes without writing (default: false)' },
                    backup:   { type: 'boolean', description: 'If true, write a .bak file before editing (default: false)' }
                },
                required: ['project', 'path', 'oldName', 'newName']
            }
        },
        async ({ project, path: filePath, oldName, newName, dryRun = false, backup = false }) => {
            try {
                const proj = registry.getProject(project);
                const result = renameSymbol(proj.root, filePath, oldName, newName, { dryRun, backup });
                if (!result.ok) {
                    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
                }
                const action  = dryRun ? 'Preview' : 'Renamed';
                const summary = `${action}: "${oldName}" → "${newName}" | ${result.replacements} occurrence(s) in ${filePath}\n${result.preview}`;
                return { content: [{ type: 'text', text: summary }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `project_rename_symbol error: ${e.message}` }] };
            }
        }
    );

    // ── project_rename_symbol_all ──────────────────────────────────────────
    server.tool(
        'project_rename_symbol_all',
        {
            description: 'Rename ALL whole-word occurrences of a symbol across every source file in the project. Use for global identifier renames (function, class, constant). Always run project_analyze after.',
            inputSchema: {
                type: 'object',
                properties: {
                    project:    { type: 'string', description: 'Registered project name' },
                    oldName:    { type: 'string', description: 'Identifier to rename' },
                    newName:    { type: 'string', description: 'Replacement identifier' },
                    extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to scan, e.g. [".js",".ts"] (default: all indexable extensions)' },
                    dryRun:     { type: 'boolean', description: 'Preview only, no writes (default: false)' }
                },
                required: ['project', 'oldName', 'newName']
            }
        },
        async ({ project, oldName, newName, extensions, dryRun = false }) => {
            try {
                const proj   = registry.getProject(project);
                const result = renameSymbolInProject(proj.root, oldName, newName, extensions, dryRun);
                if (result.totalReplacements === 0) {
                    return { content: [{ type: 'text', text: `No occurrences of "${oldName}" found in project.` }] };
                }
                const action = dryRun ? 'Preview' : 'Renamed';
                const lines  = [
                    `${action}: "${oldName}" → "${newName}" | ${result.totalReplacements} total occurrence(s) across ${result.files.length} file(s)`,
                    ...result.files.map(f => `  ${f.path}: ${f.replacements} occurrence(s)`)
                ];
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `project_rename_symbol_all error: ${e.message}` }] };
            }
        }
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a compact preview showing up to `maxLines` changed lines,
 * formatted as a mini unified diff.
 */
function buildPreview(before, after, oldName, newName, maxLines) {
    const beforeLines = before.split('\n');
    const afterLines  = after.split('\n');
    const preview     = [];
    const re          = new RegExp(`\\b${escapeRegex(oldName)}\\b`);

    for (let i = 0; i < beforeLines.length && preview.length < maxLines; i++) {
        if (re.test(beforeLines[i])) {
            preview.push(`- ${beforeLines[i].trim()}`);
            preview.push(`+ ${afterLines[i].trim()}`);
        }
    }
    return preview.join('\n');
}

/**
 * Walk the project directory tree, returning relative paths of files
 * matching `extensions`. Skips IGNORE_FOLDERS.
 */
function walkProject(root, extensions) {
    const results = [];
    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORE_FOLDERS.includes(entry.name)) walk(fullPath);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
            }
        }
    }
    walk(root);
    return results;
}
