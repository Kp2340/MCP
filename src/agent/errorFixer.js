/**
 * Error Fixer Engine — MCP-3.5 P0
 *
 * Parses a classified error from ExecutionState and attempts to generate
 * a direct project_str_replace edit — WITHOUT calling the LLM.
 *
 * Pipeline:
 *   1. Parse error text → extract file path + bad symbol/import
 *   2. Locate file in project (via mcpClient.project_search or known filesRead)
 *   3. Generate a targeted str_replace edit
 *   4. Return { tool: "project_str_replace", args: { edits, commitMessage } } or null
 *
 * Returns null if the error is too complex for deterministic fix → falls back LLM.
 */

// ─── Error text parsers (one per failure type) ────────────────────────────────

/**
 * Extract module name from import_error text.
 * Handles Node.js, Java, Python, TypeScript patterns.
 *
 * @param {string} errorText
 * @returns {{ moduleName: string|null, filePath: string|null }}
 */
function parseImportError(errorText) {
    // Node.js: Cannot find module 'express'
    const nodeMatch = errorText.match(/cannot find module ['"]([^'"]+)['"]/i);
    if (nodeMatch) return { moduleName: nodeMatch[1], filePath: extractFilePath(errorText) };

    // TypeScript: Module '"./foo"' has no exported member
    const tsMatch = errorText.match(/module ['"]([^'"]+)['"] has no/i);
    if (tsMatch) return { moduleName: tsMatch[1], filePath: extractFilePath(errorText) };

    // Java / Kotlin: unresolved reference: Foo
    const javaMatch = errorText.match(/unresolved (?:reference|import):?\s*([A-Za-z.]+)/i);
    if (javaMatch) return { moduleName: javaMatch[1], filePath: extractFilePath(errorText) };

    // Python: ImportError: No module named 'foo'
    const pyMatch = errorText.match(/no module named ['"]([^'"]+)['"]/i);
    if (pyMatch) return { moduleName: pyMatch[1], filePath: extractFilePath(errorText) };

    return { moduleName: null, filePath: extractFilePath(errorText) };
}

/**
 * Extract file path from error text (best-effort).
 * @param {string} text
 * @returns {string|null}
 */
function extractFilePath(text) {
    // e.g. "src/agent/foo.js:12:5" or "at /full/path/to/file.js:10"
    const pathMatch =
        text.match(/(?:at|in|file)\s+([^\s:]+\.[a-z]{1,5}):\d+/i) ||
        text.match(/(src\/[^\s:]+\.[a-z]{2,5})/i) ||
        text.match(/([\w/\\.-]+\.[a-z]{2,5}):\d+/i);
    return pathMatch ? pathMatch[1].trim() : null;
}

/**
 * Parse a syntax error to find the file and rough location.
 */
function parseSyntaxError(errorText) {
    return {
        filePath: extractFilePath(errorText),
        line: extractLineNumber(errorText)
    };
}

function extractLineNumber(text) {
    const m = text.match(/:(\d+)(?::\d+)?/);
    return m ? parseInt(m[1]) : null;
}

// ─── Fix generators ───────────────────────────────────────────────────────────

/**
 * Try to generate a deterministic fix for import_error.
 *
 * Strategy:
 *  - If moduleName looks like a relative path → possibly wrong casing or typo
 *  - If moduleName looks like a package → add to imports / check spelling
 *  - Generate a str_replace that removes or comments the bad import line
 *
 * @param {{ moduleName, filePath }} parsed
 * @param {string} project
 * @param {ExecutionState} execState
 * @returns {{ tool, args }|null}
 */
function buildImportFix(parsed, project, execState) {
    const { moduleName, filePath } = parsed;
    if (!filePath || !moduleName) return null;

    // Only attempt fix if we've read the file (we have its content)
    if (!execState.hasRead(filePath)) return null;

    // Generate a conservative fix: comment out the bad import line
    // (safer than deletion — LLM or human can clean up later)
    const isRelative = moduleName.startsWith(".");
    const searchLine = isRelative
        ? `from '${moduleName}'`   // ESM
        : `require('${moduleName}')`; // CJS fallback

    const replaceLine = `/* [errorFixer] unresolved: ${searchLine} */`;

    return {
        tool: "project_str_replace",
        args: {
            project,
            edits: [{
                path:    filePath,
                search:  searchLine,
                replace: replaceLine
            }],
            commitMessage: `[errorFixer] Comment out unresolved import: ${moduleName}`
        }
    };
}

/**
 * For build/syntax errors: just emit project_analyze so we get fresh error info.
 * Deterministic fix for these requires reading the exact file — handled in recovery chain.
 */
function buildAnalyzeFix(project) {
    return { tool: "project_analyze", args: { project } };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to generate a direct deterministic fix for the last error.
 *
 * @param {string}         project
 * @param {ExecutionState} execState
 * @returns {{ tool: string, args: object }|null}
 */
export function generateDirectFix(project, execState) {
    const lastErr = execState.lastError();
    if (!lastErr) return null;

    const { type, text } = lastErr;

    try {
        switch (type) {
            case "import_error": {
                const parsed = parseImportError(text);
                const fix    = buildImportFix(parsed, project, execState);
                if (fix) {
                    console.error(`[errorFixer] ⚡ Direct import fix: ${parsed.moduleName} in ${parsed.filePath}`);
                }
                return fix;
            }

            case "syntax_error": {
                // Can't fix syntax blindly — return analyze so we get updated info
                const { filePath } = parseSyntaxError(text);
                console.error(`[errorFixer] Syntax error in ${filePath || "unknown"} — emitting project_analyze`);
                return buildAnalyzeFix(project);
            }

            case "build_failure":
            case "runtime_error":
                // Emit analyze to refresh error context
                return buildAnalyzeFix(project);

            default:
                return null;
        }
    } catch (err) {
        console.error("[errorFixer] Parse error:", err.message);
        return null;
    }
}

/**
 * Extract the file path involved in the last error.
 * Used by recovery chain to know which file to read.
 *
 * @param {ExecutionState} execState
 * @returns {string|null}
 */
export function extractErrorFilePath(execState) {
    const lastErr = execState.lastError();
    if (!lastErr) return null;
    return extractFilePath(lastErr.text);
}
