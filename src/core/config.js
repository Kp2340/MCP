/**
 * src/core/config.js
 *
 * Single source of truth for all runtime configuration.
 * Every value comes from environment variables with sane defaults.
 *
 * Usage:
 *   import { config } from "./core/config.js";
 *   config.PORT  →  3001
 */

function required(key) {
    const val = process.env[key];
    if (!val) {
        console.error(`[config] FATAL: environment variable ${key} is not set.`);
        process.exit(1);
    }
    return val;
}

function optional(key, defaultValue) {
    return process.env[key] || defaultValue;
}

export const config = {
    // ── Server ──────────────────────────────────────────────────────────────
    PORT:        parseInt(optional("PORT", "3001"), 10),
    BASE_URL:    optional("BASE_URL", "http://localhost:3001"),

    // ── Auth ────────────────────────────────────────────────────────────────
    // Set API_KEY in your .env file. Requests without it will be rejected.
    API_KEY:     optional("API_KEY", ""),  // empty = auth disabled (dev only)

    // ── LLM ─────────────────────────────────────────────────────────────────
    OLLAMA_HOST: optional("OLLAMA_HOST", "http://localhost:11434"),
    LLM_MODEL:   optional("LLM_MODEL",   "qwen2.5-coder:7b"),

    // ── Vector DB ───────────────────────────────────────────────────────────
    CHROMA_HOST: optional("CHROMA_HOST", "localhost"),
    CHROMA_PORT: parseInt(optional("CHROMA_PORT", "8000"), 10),

    // ── Queue ───────────────────────────────────────────────────────────────
    // Max time a single agent job is allowed to run before forced timeout
    JOB_TIMEOUT_MS: parseInt(optional("JOB_TIMEOUT_MS", "300000"), 10),  // 5 min

    // ── CORS ────────────────────────────────────────────────────────────────
    // Comma-separated allowed origins, or * for all
    CORS_ORIGIN: optional("CORS_ORIGIN", "*"),

    // ── Mode ────────────────────────────────────────────────────────────────
    // "http"   → HTTP+SSE server (production, multi-IDE)
    // "stdio"  → Stdio transport (Claude Desktop direct connection)
    TRANSPORT:   optional("TRANSPORT", "http"),
};
