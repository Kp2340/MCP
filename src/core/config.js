/**
 * src/core/config.js — single source of truth for all runtime config.
 */

function optional(key, defaultValue) {
    return process.env[key] || defaultValue;
}

// ── Parse multi-key format: "alice:key1,bob:key2" or legacy "singlekey" ────────────────
function parseApiKeys(raw) {
    if (!raw) return {};
    // Legacy single key (no colon) — treat as user "default"
    if (!raw.includes(":")) return { default: raw.trim() };
    // Multi-key: "alice:keyAAA,bob:keyBBB,charlie:keyCCC"
    const map = {};
    for (const entry of raw.split(",")) {
        const colon = entry.indexOf(":");
        if (colon === -1) continue;
        const user = entry.slice(0, colon).trim();
        const key  = entry.slice(colon + 1).trim();
        if (user && key) map[user] = key;
    }
    return map;
}

// ── Parse IP allowlist: "192.168.1.50,192.168.1.51" ───────────────────────────
function parseIpAllowlist(raw) {
    if (!raw) return [];
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const rawKeys = optional("API_KEYS", "") || optional("API_KEY", "");
const keyMap  = parseApiKeys(rawKeys);

export const config = {
    // ── Server ───────────────────────────────────────────────────────────
    PORT:     parseInt(optional("PORT", "3001"), 10),
    BASE_URL: optional("BASE_URL", "http://localhost:3001"),

    // ── Auth ───────────────────────────────────────────────────────────
    // Per-user keys map: { alice: "keyAAA", bob: "keyBBB" }
    // Resolved from API_KEYS env var (see .env.example for format).
    API_KEY_MAP: keyMap,
    // Legacy single-key access for backward compat
    API_KEY: Object.values(keyMap)[0] || "",

    // ── IP allowlist ──────────────────────────────────────────────────
    // Optional comma-separated IPs. If set, only these IPs can connect.
    // Leave empty to allow all IPs (rely on API key alone).
    IP_ALLOWLIST: parseIpAllowlist(optional("IP_ALLOWLIST", "")),

    // ── Rate limiting ───────────────────────────────────────────────
    // Max requests per user per minute on /run endpoint.
    RATE_LIMIT_PER_MIN: parseInt(optional("RATE_LIMIT_PER_MIN", "10"), 10),

    // ── LLM ───────────────────────────────────────────────────────────
    OLLAMA_HOST: optional("OLLAMA_HOST", "http://localhost:11434"),
    LLM_MODEL:   optional("LLM_MODEL",   "qwen2.5-coder:7b"),

    // ── Vector DB ───────────────────────────────────────────────────
    CHROMA_HOST: optional("CHROMA_HOST", "localhost"),
    CHROMA_PORT: parseInt(optional("CHROMA_PORT", "8000"), 10),

    // ── Queue ──────────────────────────────────────────────────────────
    JOB_TIMEOUT_MS: parseInt(optional("JOB_TIMEOUT_MS", "300000"), 10),

    // ── CORS ───────────────────────────────────────────────────────────
    CORS_ORIGIN: optional("CORS_ORIGIN", "*"),

    // ── Security flags ────────────────────────────────────────────────
    EXPOSE_PROJECT_LIST: optional("EXPOSE_PROJECT_LIST", "false") === "true",

    // ── Mode ───────────────────────────────────────────────────────────
    TRANSPORT: optional("TRANSPORT", "http"),
};
