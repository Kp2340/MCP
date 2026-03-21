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

    // SSE-specific headers
    if (req.path === "/sse") {
        res.setHeader("Cache-Control",      "no-cache, no-store");
        res.setHeader("X-Accel-Buffering",  "no");
        // Skip ngrok's HTML interstitial page for SSE connections
        res.setHeader("ngrok-skip-browser-warning", "true");
    }

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
}
