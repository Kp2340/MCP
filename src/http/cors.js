/**
 * src/http/cors.js
 *
 * Minimal CORS middleware — no external dependencies.
 * Handles preflight OPTIONS and sets correct headers for SSE.
 *
 * Works behind Cloudflare / ngrok reverse proxies.
 */

import { config } from "../core/config.js";

export function corsMiddleware(req, res, next) {
    const origin = config.CORS_ORIGIN === "*"
        ? "*"
        : req.headers.origin || "";

    res.setHeader("Access-Control-Allow-Origin",  origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-session-id");
    res.setHeader("Access-Control-Max-Age",       "86400");  // cache preflight 24h

    // SSE connections must not be cached
    if (req.path === "/sse") {
        res.setHeader("Cache-Control", "no-cache, no-store");
        res.setHeader("X-Accel-Buffering", "no");  // disable nginx/CF buffering
    }

    // Respect X-Forwarded-Proto (Cloudflare / ngrok set this)
    const proto = req.headers["x-forwarded-proto"];
    if (proto) req.protocol = proto;

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
}
