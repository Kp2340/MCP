import { config } from "../core/config.js";

export function corsMiddleware(req, res, next) {
    const origin = config.CORS_ORIGIN === "*"
        ? "*"
        : req.headers.origin || "";

    res.setHeader("Access-Control-Allow-Origin",  origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers",
        "Content-Type, x-api-key, x-session-id, authorization, ngrok-skip-browser-warning");
    res.setHeader("Access-Control-Expose-Headers", "x-session-id");
    res.setHeader("Access-Control-Max-Age", "86400");

    // SSE anti-buffering headers — must be set on EVERY request, not just /sse.
    // Cloudflare and other reverse proxies inspect these early in the response
    // pipeline. Setting them only inside the /sse handler is too late — the
    // proxy has already decided to buffer by the time Express runs route handlers.
    res.setHeader("X-Accel-Buffering",         "no");
    res.setHeader("ngrok-skip-browser-warning", "true");

    if (req.path === "/sse") {
        res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
        res.setHeader("Connection",    "keep-alive");
    }

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
}
