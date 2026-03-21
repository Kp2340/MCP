/**
 * src/http/jobRoutes.js
 *
 * REST endpoints for the agent job queue.
 *
 * Routes:
 *   POST /run          → enqueue an agent task
 *   GET  /status/:id   → get job status + result
 *   GET  /jobs         → list recent jobs
 *   GET  /queue        → current queue status
 *   GET  /stream/:id   → SSE stream for live job updates
 *   GET  /health       → health check (no auth)
 */

import { enqueue, getJob, listJobs, getQueueStatus,
         subscribeToJob, unsubscribeFromJob }       from "./queue.js";
import { createLogger }                             from "../core/logger.js";
import { runAgent }                                 from "../agent/agentRunner.js";

const log = createLogger("job-routes");

export function attachJobRoutes(app) {

    // ── POST /run ──────────────────────────────────────────────────────────────
    app.post("/run", (req, res) => {
        const { prompt, project } = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({ error: "prompt (string) is required" });
        }
        if (!project || typeof project !== "string") {
            return res.status(400).json({ error: "project (string) is required" });
        }

        // Runner function — executed by the queue when the job's turn comes
        const runner = async (job) => {
            log.info(`Running agent | job=${job.id} | project=${project}`);
            // runAgent writes output to stderr; we capture its summary
            await runAgent(`${prompt} project: ${project}`);
            return `Agent completed task for project: ${project}`;
        };

        const job = enqueue(prompt, project, runner);
        const status = getQueueStatus();

        log.info(`Enqueued job ${job.id} | queue_depth=${status.pending + (status.running ? 1 : 0)}`);

        res.status(202).json({
            id:          job.id,
            status:      job.status,
            position:    status.pending,
            createdAt:   job.createdAt,
            streamUrl:   `/stream/${job.id}`,
            statusUrl:   `/status/${job.id}`
        });
    });

    // ── GET /status/:id ────────────────────────────────────────────────────────
    app.get("/status/:id", (req, res) => {
        const job = getJob(req.params.id);
        if (!job) {
            return res.status(404).json({ error: `Job ${req.params.id} not found` });
        }
        res.json(job);
    });

    // ── GET /jobs ──────────────────────────────────────────────────────────────
    app.get("/jobs", (req, res) => {
        const filter = req.query.status || null;  // ?status=pending|running|completed|failed
        res.json(listJobs(filter));
    });

    // ── GET /queue ──────────────────────────────────────────────────────────────
    app.get("/queue", (req, res) => {
        res.json(getQueueStatus());
    });

    // ── GET /stream/:id ────────────────────────────────────────────────────────
    // SSE stream for live updates on a specific job.
    // IDE plugins can subscribe here to get real-time progress.
    app.get("/stream/:id", (req, res) => {
        const jobId = req.params.id;
        const job   = getJob(jobId);

        if (!job) {
            return res.status(404).json({ error: `Job ${jobId} not found` });
        }

        res.setHeader("Content-Type",  "text/event-stream");
        res.setHeader("Connection",     "keep-alive");
        res.setHeader("Cache-Control",  "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        // If job is already terminal, send final event and close
        if (job.status === "completed") {
            res.write(`event: completed\ndata: ${JSON.stringify(job)}\n\n`);
            return res.end();
        }
        if (job.status === "failed") {
            res.write(`event: failed\ndata: ${JSON.stringify(job)}\n\n`);
            return res.end();
        }

        // Live job — subscribe to events
        subscribeToJob(jobId, res);

        // Heartbeat every 15s to keep connection alive through proxies
        const heartbeat = setInterval(() => {
            try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
        }, 15000);

        req.on("close", () => {
            clearInterval(heartbeat);
            unsubscribeFromJob(jobId, res);
            log.debug(`Stream closed for job ${jobId}`);
        });
    });

    // ── GET /health ────────────────────────────────────────────────────────────
    // No auth — used by Cloudflare / ngrok / load balancers
    app.get("/health", (_req, res) => {
        res.json({
            status:  "ok",
            version: "5.0.0",
            queue:   getQueueStatus()
        });
    });

    log.info("Job routes attached: POST /run  GET /status/:id  GET /jobs  GET /queue  GET /stream/:id  GET /health");
}
