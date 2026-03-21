/**
 * src/core/logger.js
 *
 * Lightweight structured logger — no external dependencies.
 * All output goes to stderr (keeps stdout clean for stdio MCP transport).
 *
 * Levels: DEBUG | INFO | WARN | ERROR
 * Format: [2025-01-15T10:23:44.123Z] [LEVEL] [module] message
 */

const LOG_LEVEL = (process.env.LOG_LEVEL || "INFO").toUpperCase();

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.INFO;

function timestamp() {
    return new Date().toISOString();
}

function write(level, module, ...args) {
    if (LEVELS[level] < currentLevel) return;
    const msg = args.map(a =>
        typeof a === "object" ? JSON.stringify(a) : String(a)
    ).join(" ");
    process.stderr.write(`[${timestamp()}] [${level.padEnd(5)}] [${module}] ${msg}\n`);
}

export function createLogger(module) {
    return {
        debug: (...args) => write("DEBUG", module, ...args),
        info:  (...args) => write("INFO",  module, ...args),
        warn:  (...args) => write("WARN",  module, ...args),
        error: (...args) => write("ERROR", module, ...args),
    };
}

// Default logger for modules that don't set their own
export const logger = createLogger("app");
