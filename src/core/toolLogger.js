/**
 * src/core/toolLogger.js
 *
 * Tool Execution Logger
 *
 * Logs every MCP tool call with:
 *   - WHO  called it  (session ID / IP / caller header)
 *   - WHICH tool      (tool name + args summary)
 *   - WHEN            (ISO timestamp)
 *   - HOW LONG        (duration in ms)
 *   - RESULT STATUS   (success / error + reason)
 *
 * Output destinations:
 *   1. stderr (coloured, human-readable)
 *   2. JSONL file at data/tool-logs/tool-execution.jsonl (structured)
 *
 * API surface:
 *   toolLogger.wrap(toolFn, toolName)  → wrapped async function
 *   toolLogger.stats()                 → aggregated stats object
 *   toolLogger.recentCalls(n)          → last n log entries
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR    = path.join(__dirname, "../../data/tool-logs");
const LOG_FILE   = path.join(LOG_DIR, "tool-execution.jsonl");
const MAX_IN_MEM = 500;   // rolling in-memory buffer for stats/recent

// Ensure log directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

// ─── In-memory ring buffer ────────────────────────────────────────────────────────────────────────
/** @type {Array<ToolLogEntry>} */
const ring = [];

/**
 * @typedef {Object} ToolLogEntry
 * @property {string}  timestamp   - ISO 8601
 * @property {string}  tool        - tool name
 * @property {string}  caller      - session/IP identifier
 * @property {object}  argsSummary - first-level args keys + sizes
 * @property {number}  durationMs  - wall-clock duration
 * @property {boolean} success     - true if no exception thrown
 * @property {string}  [error]     - error message on failure
 * @property {number}  [resultBytes] - approximate result size
 */

// ─── ANSI colour helpers (stderr only) ───────────────────────────────────────────────────────────────────
const C = {
    reset:  "\x1b[0m",
    green:  "\x1b[32m",
    red:    "\x1b[31m",
    yellow: "\x1b[33m",
    cyan:   "\x1b[36m",
    grey:   "\x1b[90m",
    bold:   "\x1b[1m"
};
const NO_COLOR = process.env.NO_COLOR || process.env.CI;
const c = (code, s) => (NO_COLOR ? s : `${code}${s}${C.reset}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** Redact secrets from args before logging */
const SENSITIVE_KEYS = new Set(["password", "token", "secret", "key", "auth", "apikey"]);
function sanitizeArgs(args) {
    if (!args || typeof args !== "object") return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (SENSITIVE_KEYS.has(k.toLowerCase())) {
            out[k] = "[REDACTED]";
        } else if (typeof v === "string" && v.length > 120) {
            out[k] = v.slice(0, 80) + `…(${v.length}ch)`;
        } else if (Array.isArray(v)) {
            out[k] = `[Array(${v.length})]`;
        } else {
            out[k] = v;
        }
    }
    return out;
}

/** Format duration nicely */
function fmtDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/** Write one JSONL line to the log file (non-blocking, best-effort) */
function writeToFile(entry) {
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    } catch { /* log write failures must never crash the server */ }
}

/** Append entry to the ring buffer (evict oldest if full) */
function pushToRing(entry) {
    ring.push(entry);
    if (ring.length > MAX_IN_MEM) ring.shift();
}

/** Print one log line to stderr */
function printToStderr(entry) {
    const icon    = entry.success ? c(C.green, "✓") : c(C.red, "✗");
    const tool    = c(C.bold + C.cyan, entry.tool);
    const caller  = c(C.grey, `by ${entry.caller}`);
    const dur     = c(entry.durationMs > 5000 ? C.yellow : C.grey, fmtDuration(entry.durationMs));
    const size    = entry.resultBytes !== undefined ? c(C.grey, ` → ${(entry.resultBytes / 1024).toFixed(1)}KB`) : "";
    const errPart = entry.error ? c(C.red, ` ERROR: ${entry.error.slice(0, 100)}`) : "";
    process.stderr.write(`[TOOL] ${icon} ${tool} ${caller} in ${dur}${size}${errPart}\n`);
}

// ─── Public API ──────────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a tool handler function with automatic logging.
 *
 * @param {Function} toolFn   - async (args, callerCtx) => result
 * @param {string}   toolName - display name for logs
 * @returns {Function}         wrapped function with same signature
 */
export function wrapTool(toolFn, toolName) {
    return async function wrappedTool(args, callerCtx = {}) {
        const caller    = callerCtx.caller || callerCtx.ip || callerCtx.sessionId || "unknown";
        const startedAt = Date.now();
        let result, success = true, error = undefined, resultBytes = undefined;

        try {
            result      = await toolFn(args, callerCtx);
            resultBytes = Buffer.byteLength(JSON.stringify(result ?? ""), "utf8");
        } catch (err) {
            success = false;
            error   = err?.message || String(err);
            throw err;   // re-throw so MCP framework still handles it
        } finally {
            const durationMs = Date.now() - startedAt;
            /** @type {ToolLogEntry} */
            const entry = {
                timestamp:   new Date().toISOString(),
                tool:        toolName,
                caller,
                argsSummary: sanitizeArgs(args),
                durationMs,
                success,
                ...(error       !== undefined ? { error }       : {}),
                ...(resultBytes !== undefined ? { resultBytes } : {})
            };
            printToStderr(entry);
            writeToFile(entry);
            pushToRing(entry);
        }

        return result;
    };
}

/**
 * Log a tool call from the MCP request handler directly (no wrapper needed).
 * Use this when you want fine-grained control over when the log entry fires.
 *
 * @param {string}  toolName
 * @param {object}  args
 * @param {string}  caller     - session/IP string
 * @param {number}  startedAt  - Date.now() before the call
 * @param {boolean} success
 * @param {string}  [error]
 * @param {number}  [resultBytes]
 */
export function logToolCall({ toolName, args, caller, startedAt, success, error, resultBytes }) {
    const durationMs = Date.now() - startedAt;
    const entry = {
        timestamp:   new Date().toISOString(),
        tool:        toolName,
        caller:      caller || "unknown",
        argsSummary: sanitizeArgs(args),
        durationMs,
        success,
        ...(error       !== undefined ? { error }       : {}),
        ...(resultBytes !== undefined ? { resultBytes } : {})
    };
    printToStderr(entry);
    writeToFile(entry);
    pushToRing(entry);
}

/**
 * Aggregate statistics for the last `windowMs` milliseconds.
 * @param {number} [windowMs=3600000]  default = last 1 hour
 */
export function stats(windowMs = 3_600_000) {
    const cutoff  = Date.now() - windowMs;
    const entries = ring.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    if (entries.length === 0) return { totalCalls: 0, tools: {} };

    const byTool = {};
    for (const e of entries) {
        if (!byTool[e.tool]) byTool[e.tool] = { calls: 0, errors: 0, totalMs: 0, callers: new Set() };
        byTool[e.tool].calls++;
        byTool[e.tool].totalMs += e.durationMs;
        if (!e.success) byTool[e.tool].errors++;
        if (e.caller) byTool[e.tool].callers.add(e.caller);
    }

    const tools = {};
    for (const [name, d] of Object.entries(byTool)) {
        tools[name] = {
            calls:       d.calls,
            errors:      d.errors,
            successRate: `${(((d.calls - d.errors) / d.calls) * 100).toFixed(1)}%`,
            avgMs:       Math.round(d.totalMs / d.calls),
            uniqueCallers: d.callers.size
        };
    }

    return {
        windowHours: (windowMs / 3_600_000).toFixed(1),
        totalCalls:  entries.length,
        totalErrors: entries.filter(e => !e.success).length,
        tools
    };
}

/**
 * Return the last n log entries (newest first).
 * @param {number} [n=20]
 */
export function recentCalls(n = 20) {
    return ring.slice(-n).reverse();
}
