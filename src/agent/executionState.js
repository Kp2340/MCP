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

// ─── Failure classifier ───────────────────────────────────────────────────────────────────────────────
// Returns a specific failure category instead of relying on generic
// "includes('error')" checks. The category is used to guide replanning.

const FAILURE_PATTERNS = [
    {
        type:     "import_error",
        patterns: [
            /cannot find module/i,
            /import.*not found/i,
            /module not found/i,
            /unresolved import/i,
            /has no exported member/i,       // TS: Module '...' has no exported member 'X'
            /failed to resolve import/i,
            /err_module_not_found/i,
            /error ts\d+.*cannot find/i
        ]
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
        patterns: [
            /not found/i,
            /does not exist/i,               // "File does not exist: ..."
            /no such file/i,
            /404/,
            /enoent/i,
            /file not found/i,
            /cannot find file/i
        ]
    },
    {
        type:     "permission_error",
        patterns: [
            /permission denied/i,
            /access denied/i,
            /forbidden/i,
            /eacces/i,
            /eperm/i
        ]
    }
];

export function classifyFailure(resultText) {
    if (!resultText) return null;
    const lower = resultText.toLowerCase();

    // Quick pre-check — if no failure signals at all, return null.
    // NOTE: must cover ALL pattern categories, not just "error"/"fail":
    //   - "does not exist" / "enoent" / "no such file" → not_found
    //   - "eacces" / "permission denied" / "eperm"     → permission_error
    //   - "has no exported member"                     → import_error (TS)
    const hasFailureSignal =
        lower.includes("error") ||
        lower.includes("fail") ||
        lower.includes("exception") ||
        lower.includes("not found") ||
        lower.includes("does not exist") ||
        lower.includes("no such file") ||
        lower.includes("enoent") ||
        lower.includes("eacces") ||
        lower.includes("eperm") ||
        lower.includes("permission denied") ||
        lower.includes("access denied") ||
        lower.includes("forbidden") ||
        lower.includes("has no exported member") ||
        lower.includes("cannot find");

    if (!hasFailureSignal) return null;

    for (const { type, patterns } of FAILURE_PATTERNS) {
        if (patterns.some(re => re.test(resultText))) {
            return type;
        }
    }

    return "unknown_error";  // failure signal present but unclassified
}

// ─── File path extractor ──────────────────────────────────────────────────────────────────────────
// Extracts relative file paths mentioned in tool args or result text.
function extractPathsFromArgs(tool, args) {
    if (!args) return [];
    const paths = [];
    if (tool === "project_read_files"   && Array.isArray(args.paths))  paths.push(...args.paths);
    if (tool === "project_apply_changes" && Array.isArray(args.files))  paths.push(...args.files.map(f => f.path).filter(Boolean));
    if (tool === "project_str_replace"  && Array.isArray(args.edits))  paths.push(...args.edits.map(e => e.path).filter(Boolean));
    return paths;
}

// ─── ExecutionState class ───────────────────────────────────────────────────────────────────────

/** Normalize path separators to forward slashes for cross-platform consistency. */
function normalizePath(p) {
    return p ? p.replace(/\\/g, "/") : p;
}

export class ExecutionState {
    constructor() {
        this.filesRead     = new Set();  // paths passed to project_read_files
        this.filesModified = new Set();  // paths written by apply_changes / str_replace
        this.filesCreated  = new Set();  // paths written for the first time (new files)
        this.toolsUsed     = [];         // [{ tool, stepIndex }]
        this.errors        = [];         // [{ type, text, stepIndex }]
        this.stepCount     = 0;
        this.idleSteps     = 0;           // incremented when no progress is made; used by progressGuard()
        this.traceId       = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        this.exitReason    = null;        // set when agent loop exits: "STEP_CAP" | "IDLE" | null
        // Tool result cache: avoid re-running identical tool calls within a run
        // Key: "toolName::JSON(args)" → Value: result text
        this._toolCache    = new Map();
    }

    /**
     * Check if an identical tool call was already made this run.
     * Returns cached result text or null.
     */
    getCachedResult(tool, args) {
        const key = `${tool}::${JSON.stringify(args)}`;
        return this._toolCache.get(key) || null;
    }

    setCachedResult(tool, args, resultText) {
        const key = `${tool}::${JSON.stringify(args)}`;
        this._toolCache.set(key, resultText);
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

        // Cache idempotent read results for dedup within a run
        if (tool === "project_read_files" || tool === "project_scan" || tool === "project_analyze") {
            this.setCachedResult(tool, args, resultText);
        }

        // Normalize all tracked paths to forward slashes
        const paths           = extractPathsFromArgs(tool, args).map(normalizePath);
        const prevModifiedSize = this.filesModified.size;
        const prevErrorCount   = this.errors.length;

        if (tool === "project_read_files") {
            paths.forEach(p => this.filesRead.add(p));
        }
        if (tool === "project_apply_changes" || tool === "project_str_replace") {
            paths.forEach(p => {
                const isNew = !this.filesRead.has(p) && !this.filesModified.has(p);
                if (isNew) this.filesCreated.add(p);
                this.filesModified.add(p);
                this.filesRead.add(p);  // modified files were implicitly read too

                // CRITICAL: invalidate the read cache for this file.
                // After a str_replace, the cached content is stale.
                // The next project_read_files call must hit disk for fresh content.
                for (const key of this._toolCache.keys()) {
                    if (key.includes(`"${p}"`) || key.includes(p)) {
                        this._toolCache.delete(key);
                    }
                }
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

        // Idle-step tracking: reset on meaningful progress, increment otherwise.
        // Used by progressGuard() in agent.js to kill stalled runs.
        // Also resets for any substantive tool result (read/search/analyze) so
        // legitimate exploration phases (read 5 files before editing) are not
        // killed by the idle-step guard prematurely.
        const SUBSTANTIVE_READ_TOOLS = new Set([
            "project_read_files", "project_scan", "project_search",
            "project_find_symbol", "project_analyze", "project_semantic_search"
        ]);
        const madeProgress = this.filesModified.size > prevModifiedSize
            || this.errors.length > prevErrorCount
            || (SUBSTANTIVE_READ_TOOLS.has(tool) && resultText && resultText.length > 50);
        this.idleSteps = madeProgress ? 0 : this.idleSteps + 1;
    }

    /** True if any failure of the given type has occurred this run. */
    hasErrorType(type) {
        return this.errors.some(e => e.type === type);
    }

    /** True if a given file has already been read this run. */
    hasRead(filePath) {
        return this.filesRead.has(normalizePath(filePath));
    }

    /** True if a given file has been modified this run. */
    hasModified(filePath) {
        return this.filesModified.has(normalizePath(filePath));
    }

    /** True if a given file was created (not just edited) this run. */
    hasCreated(filePath) {
        return this.filesCreated.has(normalizePath(filePath));
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

    if (state.traceId) {
        lines.push(`Trace ID: ${state.traceId}`);
    }
    if (state.filesRead.size > 0) {
        lines.push(`Files read: ${[...state.filesRead].slice(0, 8).join(", ")}`);
    }
    if (state.filesModified.size > 0) {
        lines.push(`Files modified: ${[...state.filesModified].slice(0, 8).join(", ")}`);
    }
    if (state.filesCreated.size > 0) {
        lines.push(`Files created: ${[...state.filesCreated].slice(0, 4).join(", ")}`);
    }
    if (state.errors.length > 0) {
        const last = state.errors[state.errors.length - 1];
        lines.push(`Last error type: ${last.type}`);
        lines.push(`Last error: ${last.text.substring(0, 120)}`);
    }
    if (state.toolsUsed.length > 0) {
        const recent = state.toolsUsed.slice(-4).map(t => t.tool).join(" \u2192 ");
        lines.push(`Recent tools: ${recent}`);
    }

    return lines.length > 0 ? lines.join("\n") : "No actions taken yet.";
}
