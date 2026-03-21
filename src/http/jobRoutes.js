/**
 * src/http/jobRoutes.js
 *
 * REST endpoints for the agent job queue.
 *
 * MCP-3.11: /run now accepts an optional "path" field so callers can
 * pass the workspace path alongside the project name. If the project name
 * isn't in the registry but a path is provided, the project is auto-registered
 * before the agent runs.
 */

import { enqueue, getJob, listJobs, getQueueStatus,
         subscribeToJob, unsubscribeFromJob }       from "./queue.js";
import { createLogger }                             from "../core/logger.js";
import { runAgent }                                 from "../agent/agentRunner.js";
import { registerDynamicProject, listProjects }     from "../core/projectRegistry.js";

const log = createLogger("job-routes");

export function attachJobRoutes(app) {

    // ── POST /run ──────────────────────────────────────────────────────────────
    app.post("/run", (req, res) => {
        const { prompt, project, path: projectPath } = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({ error: "prompt (string) is required" });
        }
        if (!project || typeof project !== "string") {
            return res.status(400).json({ error: "project (string) is required" });
        }

        // Auto-register if project unknown but a path was provided
        const knownProjects = listProjects();
        if (!knownProjects.includes(project) && projectPath) {
            try {
                registerDynamicProject(project, projectPath);
                log.info(`Auto-registered "${project}" from /run request (path: ${projectPath})`);
            } catch (err) {
                return res.status(400).json({ error: `Cannot register project: ${err.message}` });
            }
        }

        const runner = async (job) => {
            log.info(`Running agent | job=${job.id} | project=${project}`);
            await runAgent(`${prompt} project: ${project}`);
            return `Agent completed task for project: ${project}`;
        };

        const job    = enqueue(prompt, project, runner);
        const status = getQueueStatus();

        log.info(`Enqueued job ${job.id} | queue_depth=${status.pending + (status.running ? 1 : 0)}`);

        res.status(202).json({
            id:        job.id,
            status:    job.status,
            position:  status.pending,
            createdAt: job.createdAt,
            streamUrl: `/stream/${job.id}`,
            statusUrl: `/status/${job.id}`
        });
    });

    // ── GET /status/:id ────────────────────────────────────────────────────────
    app.get("/status/:id", (req, res) => {
        const job = getJob(req.params.id);
        if (!job) return res.status(404).json({ error: `Job ${req.params.id} not found` });
        res.json(job);
    });

    // ── GET /jobs ──────────────────────────────────────────────────────────────
    app.get("/jobs", (req, res) => {
        res.json(listJobs(req.query.status || null));
    });

    // ── GET /queue ─────────────────────────────────────────────────────────────
    app.get("/queue", (req, res) => {
        res.json(getQueueStatus());
    });

    // ── GET /stream/:id ────────────────────────────────────────────────────────
    app.get("/stream/:id", (req, res) => {
        const jobId = req.params.id;
        const job   = getJob(jobId);
        if (!job) return res.status(404).json({ error: `Job ${jobId} not found` });

        res.setHeader("Content-Type",     "text/event-stream");
        res.setHeader("Connection",        "keep-alive");
        res.setHeader("Cache-Control",     "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        if (job.status === "completed") {
            res.write(`event: completed\ndata: ${JSON.stringify(job)}\n\n`);
            return res.end();
        }
        if (job.status === "failed") {
            res.write(`event: failed\ndata: ${JSON.stringify(job)}\n\n`);
            return res.end();
        }

        subscribeToJob(jobId, res);

        const heartbeat = setInterval(() => {
            try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
        }, 15000);

        req.on("close", () => {
            clearInterval(heartbeat);
            unsubscribeFromJob(jobId, res);
        });
    });

    log.info("Job routes: POST /run  GET /status/:id  GET /jobs  GET /queue  GET /stream/:id");
}
