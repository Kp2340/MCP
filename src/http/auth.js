/**
 * src/http/auth.js
 *
 * API key authentication middleware.
 *
 * Reads x-api-key header and compares against config.API_KEY.
 * If API_KEY is empty (dev mode), auth is skipped with a warning logged once.
 *
 * Usage:
 *   app.use(authMiddleware);
 */

import { config } from "../core/config.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("auth");

let warnedOnce = false;

export function authMiddleware(req, res, next) {
    // Skip auth for health check — allows load balancers / tunnel probes
    if (req.path === "/health") return next();

    // Dev mode: no API key configured
    if (!config.API_KEY) {
        if (!warnedOnce) {
            log.warn("API_KEY not set — auth is DISABLED. Set API_KEY env var for production.");
            warnedOnce = true;
        }
        return next();
    }

    const provided = req.headers["x-api-key"];

    if (!provided) {
        log.warn(`Rejected unauthenticated request: ${req.method} ${req.path} from ${req.ip}`);
        return res.status(401).json({ error: "Missing x-api-key header" });
    }

    if (provided !== config.API_KEY) {
        log.warn(`Rejected invalid API key from ${req.ip}`);
        return res.status(403).json({ error: "Invalid API key" });
    }

    next();
}
