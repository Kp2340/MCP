/**
 * src/http/healthRoutes.js
 *
 * Enriched /health endpoint.
 *
 * Returns:
 *   - status, version, uptime
 *   - queue snapshot (running, pending)
 *   - training data count (confirms collection is working)
 *   - registered project count
 *
 * No auth required (monitoring tools need this unauthenticated).
 * Import and call attachHealthRoutes(app) in index.js before other routes.
 */

import os   from "os";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getQueueStatus } from "./queue.js";
import { listProjects }   from "../core/projectRegistry.js";
import { TrainingCollector } from "../training/collector.js";
import { config }         from "../core/config.js";
import { createLogger }   from "../core/logger.js";

const log       = createLogger("health");
const startedAt = Date.now();

// Read version from package.json so it never goes stale
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let VERSION = "unknown";
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));
    VERSION = pkg.version || "unknown";
} catch { /* ignore — VERSION stays "unknown" */ }

export function attachHealthRoutes(app) {
    app.get("/health", (_req, res) => {
        try {
            const queue    = getQueueStatus();
            const projects = listProjects();
            const training = new TrainingCollector().count();

            res.json({
                status:          "ok",
                version:         VERSION,
                uptimeSeconds:   Math.floor((Date.now() - startedAt) / 1000),
                transport:       config.TRANSPORT,
                corsOrigin:      config.CORS_ORIGIN,
                queue: {
                    running:      queue.running,
                    pending:      queue.pending,
                    currentJobId: queue.currentJobId || null,
                    total:        queue.total
                },
                projects: {
                    count:  projects.length,
                    names:  config.EXPOSE_PROJECT_LIST ? projects : undefined
                },
                training: {
                    enabled: process.env.COLLECT_TRAINING_DATA === "1",
                    examples: training
                },
                system: {
                    platform:    process.platform,
                    nodeVersion: process.version,
                    freeMemMb:   Math.floor(os.freemem() / 1024 / 1024)
                }
            });
        } catch (err) {
            log.error("Health check error:", err.message);
            res.status(500).json({ status: "error", error: err.message });
        }
    });

    log.info("Health route attached: GET /health");
}
