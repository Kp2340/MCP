/**
 * src/http/auth.js
 *
 * Three-layer security:
 *
 *  Layer 1 — IP allowlist (optional)
 *  Layer 2 — Per-user API keys (skipped for /sse and /message — claude.ai web
 *             cannot send headers in the MCP connector dialog)
 *  Layer 3 — Rate limiting per user on /run
 */

import { config } from "../core/config.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("auth");

// Routes that never require auth
// /sse     = Legacy SSE transport — claude.ai web cannot send headers in the connector dialog
// /message = Paired with /sse above
// /health  = Always public for monitoring
//
// ⚠ SECURITY: /sse and /message are intentionally unauthenticated because the
// claude.ai web connector cannot send custom request headers. If this server is
// exposed to the internet you MUST restrict access at the network layer instead:
//   - Cloudflare Access / Zero Trust in front of the tunnel
//   - Tailscale ACLs so only your devices can reach port 3001
//   - IP_ALLOWLIST in .env (Layer 1 above) to whitelist known IPs
// Application-layer auth cannot protect these two endpoints.
//
// /mcp (Streamable HTTP) IS protected — IDE extensions and CLI tools
// (Gemini CLI, Claude Code, Cursor) can send x-api-key headers.
const PUBLIC_PATHS = new Set(["/health", "/health/", "/sse", "/message"]);

// ── Rate limit state ──────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const WINDOW_MS    = 60_000;

// Evict stale entries every 10 minutes to prevent unbounded memory growth.
// An entry is stale when its window expired more than 2x ago (safe margin).
setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS * 2;
    for (const [user, entry] of rateLimitMap) {
        if (entry.windowStart < cutoff) rateLimitMap.delete(user);
    }
}, 10 * 60_000).unref();

function checkRateLimit(user) {
    const now = Date.now();
    const max = config.RATE_LIMIT_PER_MIN;
    if (!rateLimitMap.has(user)) {
        rateLimitMap.set(user, { count: 1, windowStart: now });
        return true;
    }
    const entry = rateLimitMap.get(user);
    if (now - entry.windowStart > WINDOW_MS) {
        entry.count = 1; entry.windowStart = now;
        return true;
    }
    entry.count++;
    if (entry.count > max) {
        log.warn(`Rate limit exceeded for user "${user}" (${entry.count}/${max} req/min)`);
        return false;
    }
    return true;
}

function resolveUser(providedKey) {
    for (const [user, key] of Object.entries(config.API_KEY_MAP)) {
        if (key === providedKey) return user;
    }
    return null;
}

let warnedOnce = false;

// ── Layer 1: IP allowlist ────────────────────────────────────────────────────
export function ipAllowlistMiddleware(req, res, next) {
    const allowed = config.IP_ALLOWLIST;
    if (allowed.length === 0) return next();
    if (PUBLIC_PATHS.has(req.path)) return next(); // never block SSE/health by IP
    const clientIp = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    if (!allowed.includes(clientIp)) {
        log.warn(`IP blocked: ${clientIp} not in allowlist`);
        return res.status(403).json({ error: "IP not allowed" });
    }
    next();
}

// ── Layer 2: API key auth ────────────────────────────────────────────────────
export function authMiddleware(req, res, next) {
    // /sse and /message are public — claude.ai web cannot send headers
    // /health is always public for monitoring
    if (PUBLIC_PATHS.has(req.path)) return next();

    const hasKeys = Object.keys(config.API_KEY_MAP).length > 0;
    if (!hasKeys) {
        if (!warnedOnce) {
            log.warn("No API keys configured — auth is DISABLED. Set API_KEYS in .env.");
            warnedOnce = true;
        }
        req.user = "anonymous";
        return next();
    }

    const provided = req.headers["x-api-key"];
    if (!provided) {
        log.warn(`Rejected unauthenticated: ${req.method} ${req.path} from ${req.ip}`);
        return res.status(401).json({ error: "Missing x-api-key header" });
    }

    const user = resolveUser(provided);
    if (!user) {
        log.warn(`Rejected invalid API key from ${req.ip}`);
        return res.status(403).json({ error: "Invalid API key" });
    }

    req.user = user;
    log.info(`Auth OK: user="${user}" ${req.method} ${req.path}`);
    next();
}

// ── Layer 3: Rate limit (only /run) ─────────────────────────────────────────
export function rateLimitMiddleware(req, res, next) {
    const user = req.user || "anonymous";
    if (!checkRateLimit(user)) {
        return res.status(429).json({
            error: `Rate limit exceeded. Max ${config.RATE_LIMIT_PER_MIN} requests/min per user.`
        });
    }
    next();
}
