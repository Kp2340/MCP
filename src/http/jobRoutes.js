/**
 * src/http/jobRoutes.js
 *
 * REST endpoints for the agent job queue.
 *
 * Security: project name is NEVER accepted from the caller.
 * The project is always derived from the workspace path sent by the IDE extension.
 *
 * Endpoints:
 *   POST /run          Submit a task
 *   GET  /status/:id   Poll job status
 *   GET  /stream/:id   Live SSE progress
 *   GET  /jobs         List all jobs
 *   GET  /queue        Queue status
 *   GET  /diff/:id     Git diff of changes made by a completed job (for review panel)
 *   POST /revert/:id   Undo — git reset --hard HEAD~1 (reject changes)
 */

import path        from "path";
import { spawnSync } from "child_process";
import { enqueue, getJob, listJobs, getQueueStatus,
         subscribeToJob, unsubscribeFromJob, emitJobStep } from "./queue.js";
import { createLogger }                from "../core/logger.js";
import { runAgent }                    from "../agent/agentRunner.js";
import { registerDynamicProject,
         listProjects, getProject }    from "../core/projectRegistry.js";

const log = createLogger("job-routes");

export function attachJobRoutes(app) {

    // ── POST /run ──────────────────────────────────────────────────────────────
    app.post("/run", (req, res) => {
        const { prompt, path: projectPath } = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({ error: "prompt (string) is required" });
        }
        if (!projectPath || typeof projectPath !== "string") {
            return res.status(400).json({ error: "path (string) is required — send your workspace root path" });
        }

        // Derive project name securely from path — caller cannot inject a name
        const project = path.basename(projectPath)
            .replace(/[^a-zA-Z0-9-_]/g, "-")
            .toLowerCase();

        // Auto-register project from path if not already known
        if (!listProjects().includes(project)) {
            try {
                registerDynamicProject(project, projectPath);
                log.info(`Auto-registered "${project}" from path: ${projectPath}`);
            } catch (err) {
                return res.status(400).json({ error: `Cannot register project: ${err.message}` });
            }
        }

        const runner = async (job) => {
            log.info(`Running agent | job=${job.id} | project=${project}`);
            const emit = (step, detail) => emitJobStep(job.id, step, detail);
            await runAgent(`${prompt} project: ${project}`, emit);
            return `Agent completed task for project: ${project}`;
        };

        const job    = enqueue(prompt, project, runner);
        const status = getQueueStatus();
        log.info(`Enqueued job ${job.id} | project=${project} | queue_depth=${status.pending + (status.running ? 1 : 0)}`);

        res.status(202).json({
            id:        job.id,
            status:    job.status,
            project,
            position:  status.pending,
            createdAt: job.createdAt,
            streamUrl: `/stream/${job.id}`,
            statusUrl: `/status/${job.id}`,
            diffUrl:   `/diff/${job.id}`
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

    // ── GET /diff/:id ──────────────────────────────────────────────────────────
    // Returns the git diff of the last commit made by a completed job.
    // IDE extensions call this to populate the Accept/Reject review panel.
    app.get("/diff/:id", (req, res) => {
        const job = getJob(req.params.id);
        if (!job) return res.status(404).json({ error: `Job ${req.params.id} not found` });
        if (job.status !== "completed") {
            return res.status(400).json({ error: `Job is ${job.status} — diff only available after completion` });
        }
        try {
            const proj = getProject(job.project);
            const root = proj.root;

            // Commit info
            const commitHash = spawnSync("git", ["log", "-1", "--format=%H"],   { cwd: root, encoding: "utf-8" }).stdout.trim();
            const commitMsg  = spawnSync("git", ["log", "-1", "--format=%s"],   { cwd: root, encoding: "utf-8" }).stdout.trim();
            const commitTime = spawnSync("git", ["log", "-1", "--format=%ci"],  { cwd: root, encoding: "utf-8" }).stdout.trim();

            // Full unified diff
            const diff = spawnSync("git", ["diff", "HEAD~1", "HEAD"],
                { cwd: root, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }).stdout || "";

            // File-level summary: M modified, A added, D deleted
            const filesRaw = spawnSync("git", ["diff", "--name-status", "HEAD~1", "HEAD"],
                { cwd: root, encoding: "utf-8" }).stdout || "";
            const files = filesRaw.trim().split("\n").filter(Boolean).map(line => {
                const [status, ...parts] = line.split("\t");
                return { status: status.trim(), path: parts.join("\t") };
            });

            res.json({ jobId: job.id, project: job.project, commitHash, commitMsg, commitTime, files, diff });
        } catch (err) {
            log.error(`GET /diff/${req.params.id} error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // ── POST /revert/:id ───────────────────────────────────────────────────────
    // Reverts the last commit made by a job — called when user clicks "Reject".
    // Uses git reset --hard HEAD~1 to fully discard the agent's changes.
    app.post("/revert/:id", (req, res) => {
        const job = getJob(req.params.id);
        if (!job) return res.status(404).json({ error: `Job ${req.params.id} not found` });
        if (job.status !== "completed") {
            return res.status(400).json({ error: `Job is ${job.status} — can only revert completed jobs` });
        }
        try {
            const proj   = getProject(job.project);
            const result = spawnSync("git", ["reset", "--hard", "HEAD~1"],
                { cwd: proj.root, encoding: "utf-8" });
            if (result.status !== 0) {
                return res.status(500).json({ error: result.stderr || "git reset failed" });
            }
            log.info(`Reverted job ${job.id} | project=${job.project}`);
            res.json({ ok: true, message: `Reverted changes for job ${job.id}` });
        } catch (err) {
            log.error(`POST /revert/${req.params.id} error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    log.info("Job routes attached: POST /run  GET /status  GET /stream  GET /diff  POST /revert");
}
