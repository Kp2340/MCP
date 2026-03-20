/**
 * Execution State Engine
 *
 * Tracks structured state across the entire agent run:
 *   - which files were read / modified
 *   - which tools were used
 *   - errors seen (raw text + classified type)
 *
 * Used by:
 *   - agent.js  — maintained and passed around
 *   - planner.js — injected into replan prompts for better reasoning
 *   - executor.js — injected alongside memory context
 *
 * Replaces the unstructured "executionContext string" as the source of truth
 * for WHAT has happened, while the string remains the source of truth for
 * WHAT WAS SAID (LLM context).
 */

// ─── Failure classifier ───────────────────────────────────────────────────────
// Returns a specific failure category instead of relying on generic
// "includes('error')" checks. The category is used to guide replanning.

const FAILURE_PATTERNS = [
    {
        type:     "import_error",
        patterns: [/cannot find module/i, /import.*not found/i, /module not found/i, /unresolved import/i]
    },
    {
        type:     "syntax_error",
        patterns: [/syntaxerror/i, /unexpected token/i, /unexpected end/i, /parse error/i]
    },
    {
        type:     "build_failure",
        patterns: [/build failed/i, /compilation failed/i, /task.*failed/i, /error:.*\.java/i]
    },
    {
        type:     "runtime_error",
        patterns: [/typeerror/i, /referenceerror/i, /nullpointerexception/i, /classnotfoundexception/i, /stack trace/i]
    },
    {
        type:     "not_found",
        patterns: [/not found/i, /does not exist/i, /no such file/i, /404/]
    },
    {
        type:     "permission_error",
        patterns: [/permission denied/i, /access denied/i, /forbidden/i, /eacces/i]
    }
];

export function classifyFailure(resultText) {
    if (!resultText) return null;
    const lower = resultText.toLowerCase();

    // Quick pre-check — if no failure signals at all, return null
    const hasFailureSignal =
        lower.includes("error") ||
        lower.includes("fail") ||
        lower.includes("exception") ||
        lower.includes("not found");

    if (!hasFailureSignal) return null;

    for (const { type, patterns } of FAILURE_PATTERNS) {
        if (patterns.some(re => re.test(resultText))) {
            return type;
        }
    }

    return "unknown_error";  // failure signal present but unclassified
}

// ─── File path extractor ─────────────────────────────────────────────────────
// Extracts relative file paths mentioned in tool args or result text.
function extractPathsFromArgs(tool, args) {
    if (!args) return [];
    const paths = [];
    if (tool === "project_read_files"   && Array.isArray(args.paths))  paths.push(...args.paths);
    if (tool === "project_apply_changes" && Array.isArray(args.files))  paths.push(...args.files.map(f => f.path).filter(Boolean));
    if (tool === "project_str_replace"  && Array.isArray(args.edits))  paths.push(...args.edits.map(e => e.path).filter(Boolean));
    return paths;
}

// ─── ExecutionState class ─────────────────────────────────────────────────────

export class ExecutionState {
    constructor() {
        this.filesRead     = new Set();  // paths passed to project_read_files
        this.filesModified = new Set();  // paths written by apply_changes / str_replace
        this.toolsUsed     = [];         // [{ tool, stepIndex }]
        this.errors        = [];         // [{ type, text, stepIndex }]
        this.stepCount     = 0;
    }

    /**
     * Update state after a tool call completes.
     * @param {string} tool        - tool name
     * @param {object} args        - tool args
     * @param {string} resultText  - tool result text
     * @param {number} stepIndex
     */
    recordToolCall(tool, args, resultText, stepIndex) {
        this.stepCount = stepIndex;
        this.toolsUsed.push({ tool, stepIndex });

        const paths = extractPathsFromArgs(tool, args);

        if (tool === "project_read_files") {
            paths.forEach(p => this.filesRead.add(p));
        }
        if (tool === "project_apply_changes" || tool === "project_str_replace") {
            paths.forEach(p => {
                this.filesModified.add(p);
                this.filesRead.add(p);  // modified files were implicitly read too
            });
        }

        const failureType = classifyFailure(resultText);
        if (failureType) {
            this.errors.push({
                type:      failureType,
                text:      resultText.substring(0, 300),
                stepIndex
            });
        }
    }

    /** True if any failure of the given type has occurred this run. */
    hasErrorType(type) {
        return this.errors.some(e => e.type === type);
    }

    /** True if a given file has already been read this run. */
    hasRead(filePath) {
        return this.filesRead.has(filePath);
    }

    /** True if a given file has been modified this run. */
    hasModified(filePath) {
        return this.filesModified.has(filePath);
    }

    /** Most recent error, or null. */
    lastError() {
        return this.errors.length > 0 ? this.errors[this.errors.length - 1] : null;
    }
}

/** Factory — creates a fresh ExecutionState for a new run. */
export function makeExecutionState() {
    return new ExecutionState();
}

/**
 * Format execution state as a compact string for injection into prompts.
 * Keeps it short to avoid burning tokens on state description.
 */
export function formatStateForPrompt(state) {
    const lines = [];

    if (state.filesRead.size > 0) {
        lines.push(`Files read: ${[...state.filesRead].slice(0, 8).join(", ")}`);
    }
    if (state.filesModified.size > 0) {
        lines.push(`Files modified: ${[...state.filesModified].slice(0, 8).join(", ")}`);
    }
    if (state.errors.length > 0) {
        const last = state.errors[state.errors.length - 1];
        lines.push(`Last error type: ${last.type}`);
        lines.push(`Last error: ${last.text.substring(0, 120)}`);
    }
    if (state.toolsUsed.length > 0) {
        const recent = state.toolsUsed.slice(-4).map(t => t.tool).join(" → ");
        lines.push(`Recent tools: ${recent}`);
    }

    return lines.length > 0 ? lines.join("\n") : "No actions taken yet.";
}
