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
import { ChromaClient } from "chromadb";
import { getQueueStatus } from "./queue.js";
import { listProjects }   from "../core/projectRegistry.js";
import { TrainingCollector } from "../training/collector.js";
import { config }         from "../core/config.js";
import { createLogger }   from "../core/logger.js";
import { stats as toolStats, recentCalls } from "../core/toolLogger.js";
import { CHROMA_HOST, CHROMA_PORT, OLLAMA_HOST } from "../core/constants.js";
import { isOllamaAvailable }                      from "../agent/ollamaClient.js";

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

    // ── GET /api/tool-stats ───────────────────────────────────────────────────────────────────────────
    // Aggregated stats for tool calls in the last N hours (default 1).
    // Query param: ?hours=N  (min 0.016 = 1 min, max 48)
    // No auth required — same pattern as /health (monitoring tools need this).
    app.get("/api/tool-stats", (req, res) => {
        try {
            const hours    = parseFloat(req.query.hours ?? "1");
            const windowMs = Math.min(Math.max(hours * 3_600_000, 60_000), 48 * 3_600_000);
            const s        = toolStats(windowMs);
            res.json({
                windowHours:  s.windowHours,
                totalCalls:   s.totalCalls,
                totalErrors:  s.totalErrors,
                tools:        s.tools,
                recent:       recentCalls(20)
            });
        } catch (err) {
            log.error("Tool stats error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log.info("Tool stats route attached: GET /api/tool-stats");

    // -- GET /api/health/deep --------------------------------------------------
    // Deep liveness check: probes ChromaDB heartbeat + Ollama /api/tags.
    // Slightly slower than /health (makes real network calls to dependencies).
    // Use for monitoring dashboards, not in hot paths.
    app.get("/api/health/deep", async (_req, res) => {
        const results = {
            chromadb: { status: "unknown", latencyMs: null },
            ollama:   { status: "unknown", latencyMs: null, models: [] }
        };

        // Check ChromaDB
        try {
            const chromaClient = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
            const t0 = Date.now();
            await chromaClient.heartbeat();
            results.chromadb = { status: "healthy", latencyMs: Date.now() - t0 };
        } catch (err) {
            results.chromadb = { status: "unhealthy", error: err.message, latencyMs: null };
        }

        // Check Ollama via shared client (consistent with LLM call path)
        try {
            const t0 = Date.now();
            const ollamaStatus = await isOllamaAvailable();
            const ms = Date.now() - t0;
            results.ollama = ollamaStatus.available
                ? { status: "healthy",   latencyMs: ms, models: ollamaStatus.models }
                : { status: "unhealthy", latencyMs: ms, error: ollamaStatus.error || "unreachable", models: [] };
        } catch (err) {
            results.ollama = { status: "unhealthy", latencyMs: null, error: err.message, models: [] };
        }

        const allHealthy = results.chromadb.status === "healthy" &&
                           results.ollama.status   === "healthy";

        res.status(allHealthy ? 200 : 503).json({
            status:    allHealthy ? "healthy" : "degraded",
            timestamp: new Date().toISOString(),
            version:   VERSION,
            services:  results,
            projects:  listProjects().length
        });
    });

    log.info("Deep health check route attached: GET /api/health/deep");
}
