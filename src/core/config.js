/**
 * src/core/config.js — single source of truth for all runtime config.
 *
 * Auto-loads .env from the project root using Node 20's built-in fs reader.
 * This means `node src/index.js` works without needing dotenv package or
 * manually setting env vars in the shell first.
 * System env vars always take precedence over .env values.
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath   = path.resolve(__dirname, "../../.env");

// Load .env file into process.env — only sets vars not already in environment
// so system-level overrides (e.g. CI, Docker) always win.
if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;  // skip blanks + comments
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) {  // don't override existing env vars
            process.env[key] = val;
        }
    }
}

function optional(key, defaultValue) {
    return process.env[key] || defaultValue;
}

// Parse multi-key format: "alice:key1,bob:key2" or legacy "singlekey"
function parseApiKeys(raw) {
    if (!raw) return {};
    if (!raw.includes(":")) return { default: raw.trim() };
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

// Parse IP allowlist: "192.168.1.50,192.168.1.51"
function parseIpAllowlist(raw) {
    if (!raw) return [];
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Parse allowed roots: "C:/Users/kushp/IdeaProjects,C:/Work"
function parseAllowedRoots(raw) {
    if (!raw) return [];
    return raw.split(",")
        .map(s => s.trim().replace(/[\\/]+$/, ""))  // strip trailing slashes
        .filter(Boolean)
        .map(s => path.resolve(s));                  // normalise to absolute
}

const rawKeys = optional("API_KEYS", "") || optional("API_KEY", "");
const keyMap  = parseApiKeys(rawKeys);

export const config = {
    // Server
    PORT:     parseInt(optional("PORT", "3001"), 10),
    HOST:     optional("HOST", "0.0.0.0"), 
    BASE_URL: optional("BASE_URL", "http://localhost:3001"),

    // Auth
    API_KEY_MAP: keyMap,
    API_KEY:     Object.values(keyMap)[0] || "",

    // IP allowlist
    IP_ALLOWLIST: parseIpAllowlist(optional("IP_ALLOWLIST", "")),

    // Rate limiting
    RATE_LIMIT_PER_MIN: parseInt(optional("RATE_LIMIT_PER_MIN", "10"), 10),

    // LLM
    OLLAMA_HOST: optional("OLLAMA_HOST", "http://localhost:11434"),
    GEMINI_API_KEY: optional("GEMINI_API_KEY", ""),
    LLM_MODEL:   optional("LLM_MODEL",   "qwen2.5-coder:7b"),

    // Vector DB
    CHROMA_HOST: optional("CHROMA_HOST", "localhost"),
    CHROMA_PORT: parseInt(optional("CHROMA_PORT", "8000"), 10),

    // Queue
    JOB_TIMEOUT_MS: parseInt(optional("JOB_TIMEOUT_MS", "300000"), 10),

    // CORS
    CORS_ORIGIN: optional("CORS_ORIGIN", "*"),

    // Security
    EXPOSE_PROJECT_LIST: optional("EXPOSE_PROJECT_LIST", "false") === "true",

    // Allowlist of directory prefixes that project_register may use.
    // If non-empty, any registration attempt outside these roots is rejected.
    // Example: ALLOWED_ROOTS=C:/Users/kushp/IdeaProjects,C:/Users/kushp/Work
    ALLOWED_ROOTS: parseAllowedRoots(optional("ALLOWED_ROOTS", "")),

    // When true, project_register via the MCP tool is completely disabled.
    // Remote callers can only use projects pre-listed in projects.json.
    // STRONGLY recommended: true for any server exposed to the public internet.
    DISABLE_REMOTE_REGISTER: optional("DISABLE_REMOTE_REGISTER", "false") === "true",

    // Transport
    TRANSPORT: optional("TRANSPORT", "http"),
};
