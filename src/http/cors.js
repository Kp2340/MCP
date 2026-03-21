import { config } from "../core/config.js";

export function corsMiddleware(req, res, next) {
    const origin = config.CORS_ORIGIN === "*"
        ? "*"
        : req.headers.origin || "";

    res.setHeader("Access-Control-Allow-Origin",  origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-session-id, ngrok-skip-browser-warning");
    res.setHeader("Access-Control-Max-Age",       "86400");

    if (req.path === "/sse") {
        res.setHeader("Cache-Control", "no-cache, no-store");
        res.setHeader("X-Accel-Buffering", "no");
    }

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
}