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
 *   POST /revert/:id   Undo agent changes (safe git revert by default, ?hard=true for reset)
 */

import path        from "path";
import { spawnSync } from "child_process";
import { enqueue, getJob, listJobs, getQueueStatus,
         subscribeToJob, unsubscribeFromJob, emitJobStep, cancelJob } from "./queue.js";
import { createLogger }                from "../core/logger.js";
import { runAgent }                    from "../agent/agentRunner.js";
import { registerDynamicProject, saveProject,
         listProjects, getProject, listDynamicProjects } from "../core/projectRegistry.js";
import { createCheckpoint }           from "../git/checkpoint.js";

const log = createLogger("job-routes");

/**
 * Wraps an async route handler so any rejected promise is forwarded to
 * Express's next(err) — caught by the global error handler in startHttpServer.
 * Without this wrapper, async throws in route handlers crash silently.
 */
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function attachJobRoutes(app) {

    // ── POST /run ──────────────────────────────────────────────────────────────
    //
    // SECURITY: Only pre-registered project names (from projects.json or
    // server-side project_register) are accepted. Arbitrary filesystem paths
    // from clients are NEVER trusted — doing so would allow any API-key holder
    // to point the agent at any directory on this machine.
    //
    // Clients send: { prompt: "...", project: "jsv" }   ← project name only
    // Legacy field:  { prompt: "...", path: "/abs/path" } ← still accepted but
    //                the basename is used ONLY to look up a pre-registered project;
    //                the path itself is NEVER used as a filesystem root.
    app.post("/run", asyncRoute(async (req, res) => {
        const {prompt, project: projectParam, path: legacyPath} = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({error: "prompt (string) is required"});
        }

        // Resolve the project name from the request.
        // Accept either `project` (preferred) or derive from basename of `path` (legacy).
        let project;
        if (projectParam && typeof projectParam === "string") {
            project = projectParam.trim().toLowerCase().replace(/[^a-zA-Z0-9-_]/g, "-");
        } else if (legacyPath && typeof legacyPath === "string") {
            // Legacy: IDE sent an absolute path. Use basename as the lookup key ONLY.
            project = path.basename(legacyPath.trim())
                .replace(/[^a-zA-Z0-9-_]/g, "-")
                .toLowerCase();
        } else {
            return res.status(400).json({
                error: "project (string) is required — send the registered project name, e.g. \"jsv\""
            });
        }

        if (!project || project.length < 1) {
            return res.status(400).json({error: "Cannot resolve project name"});
        }

        // ── SECURITY GATE ────────────────────────────────────────────────────
        // Project MUST be pre-registered on the server (projects.json or
        // explicit server-side project_register call).
        // We never auto-register from a client-supplied path.
        if (!listProjects().includes(project)) {
            log.warn(`Rejected unknown project "${project}" from ${req.ip} (user: ${req.user})`);

            // Give a helpful specific error: if the caller sent a path and that path
            // doesn't exist on this machine, explain the remote-machine problem clearly.
            let hint = "Ask the server admin to add it to projects.json.";
            if (legacyPath && typeof legacyPath === "string") {
                const { default: fs } = await import("fs");
                const { default: nodePath } = await import("path");
                const absPath = nodePath.resolve(legacyPath.trim());
                if (!fs.existsSync(absPath)) {
                    hint = `The path "${legacyPath}" does not exist on this server machine. ` +
                        `This server runs on a different computer — you cannot use your local path here. ` +
                        `Ask the server admin to clone/copy your project to the server and add it to projects.json.`;
                }
            }

            const { config } = await import("../core/config.js");
            const body = { error: `Project "${project}" is not registered on this server.`, hint };
            if (config.EXPOSE_PROJECT_LIST) body.knownProjects = listProjects();
            return res.status(403).json(body);
        }

        const runner = async (job) => {
            log.info(`Running agent | job=${job.id} | project=${project}`);
            const emit = (step, detail) => emitJobStep(job.id, step, detail);

            // Create a git stash checkpoint before the agent touches any files.
            // This gives users a guaranteed rollback point beyond the last commit.
            try {
                const proj = getProject(project);
                const cp = createCheckpoint(proj.root, `ai-dev-mcp job ${job.id}`);
                if (cp.stashed) log.info(`Checkpoint stash created: ${cp.ref} for job ${job.id}`);
            } catch (cpErr) {
                log.warn(`Checkpoint failed (non-fatal): ${cpErr.message}`);
            }

            await runAgent(`${prompt} project: ${project}`, emit);
            return `Agent completed task for project: ${project}`;
        };

        const job = enqueue(prompt, project, runner);
        const status = getQueueStatus();
        log.info(`Enqueued job ${job.id} | project=${project} | queue_depth=${status.pending + (status.running ? 1 : 0)}`);

        res.status(202).json({
            id: job.id,
            status: job.status,
            project,
            position: status.pending,
            createdAt: job.createdAt,
            streamUrl: `/stream/${job.id}`,
            statusUrl: `/status/${job.id}`,
            diffUrl: `/diff/${job.id}`
        });
    }));

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
            res.write(`event: completed
data: ${JSON.stringify(job)}

`);
            return res.end();
        }
        if (job.status === "failed") {
            res.write(`event: failed
data: ${JSON.stringify(job)}

`);
            return res.end();
        }

        subscribeToJob(jobId, res);
        const heartbeat = setInterval(() => {
            try { res.write(":heartbeat"); } catch { clearInterval(heartbeat); }
        }, 15000);
        req.on("close", () => {
            clearInterval(heartbeat);
            unsubscribeFromJob(jobId, res);
        });
    });

    // ── GET /diff/:id ──────────────────────────────────────────────────────────
    // Returns the git diff of the last commit made by a completed job.
    // IDE extensions call this to populate the Accept/Reject review panel.
    app.get("/diff/:id", asyncRoute(async (req, res) => {
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
            const files = filesRaw.trim().split("").filter(Boolean).map(line => {
                const [status, ...parts] = line.split("	");
                return { status: status.trim(), path: parts.join("	") };
            });

            res.json({ jobId: job.id, project: job.project, commitHash, commitMsg, commitTime, files, diff });
        } catch (err) {
            log.error(`GET /diff/${req.params.id} error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    }));

    // ── POST /revert/:id ───────────────────────────────────────────────────────
    // Reverts the last commit made by a job using git revert (safe) or git reset.
    // Default: git revert HEAD --no-edit  (creates an undo commit, preserves history)
    // ?hard=true: git reset --hard HEAD~1  (destructive — only if caller confirms)
    app.post("/revert/:id", asyncRoute(async (req, res) => {
        const job = getJob(req.params.id);
        if (!job) return res.status(404).json({ error: `Job ${req.params.id} not found` });
        if (job.status !== "completed") {
            return res.status(400).json({ error: `Job is ${job.status} — can only revert completed jobs` });
        }

        const useHardReset = req.query.hard === "true";

        try {
            const proj = getProject(job.project);

            // Check there IS a commit to revert (repo must have at least 1 commit)
            const logCheck = spawnSync("git", ["log", "--oneline", "-1"],
                { cwd: proj.root, encoding: "utf-8" });
            if (!logCheck.stdout?.trim()) {
                return res.status(400).json({ error: "No commits to revert" });
            }

            let result;
            if (useHardReset) {
                // Destructive: wipes the commit AND working tree changes
                result = spawnSync("git", ["reset", "--hard", "HEAD~1"],
                    { cwd: proj.root, encoding: "utf-8" });
            } else {
                // Safe default: creates a new revert commit, history preserved
                result = spawnSync("git", ["revert", "HEAD", "--no-edit"],
                    { cwd: proj.root, encoding: "utf-8" });
            }

            if (result.status !== 0) {
                return res.status(500).json({ error: result.stderr || "git revert failed" });
            }

            const mode = useHardReset ? "hard-reset" : "safe-revert";
            log.info(`Reverted job ${job.id} | project=${job.project} | mode=${mode}`);
            res.json({ ok: true, mode, message: `Reverted changes for job ${job.id} (${mode})` });
        } catch (err) {
            log.error(`POST /revert/${req.params.id} error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    }));

    // ── POST /cancel/:id ───────────────────────────────────────────────────────
    // Cancel a queued (pending) job before it starts.
    app.post("/cancel/:id", (req, res) => {
        const cancelled = cancelJob(req.params.id);
        if (!cancelled) {
            const job = getJob(req.params.id);
            if (!job) return res.status(404).json({ error: `Job ${req.params.id} not found` });
            return res.status(400).json({ error: `Cannot cancel job in state "${job.status}" — only pending jobs can be cancelled` });
        }
        res.json({ ok: true, message: `Job ${req.params.id} cancelled` });
    });

    // ── GET /api/projects ─────────────────────────────────────────────────────
    // List all registered projects with their config.
    app.get("/api/projects", (_req, res) => {
        try {
            const names   = listProjects();
            const dynamic = listDynamicProjects();
            const dynamicNames = new Set(dynamic.map(d => d.name));
            const projects = names.map(name => {
                try {
                    const p = getProject(name);
                    return {
                        name,
                        root:         p.root,
                        type:         p.type,
                        buildCommand: p.buildCommand || "",
                        dynamic:      dynamicNames.has(name)
                    };
                } catch {
                    return { name, error: "Could not load config" };
                }
            });
            res.json({ count: projects.length, projects });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── POST /api/projects ────────────────────────────────────────────────────
    // Register a new project at runtime.
    app.post("/api/projects", (req, res) => {
        const { name, path: rootPath, type, persist } = req.body || {};
        if (!name || typeof name !== "string") return res.status(400).json({ error: "name (string) required" });
        if (!rootPath || typeof rootPath !== "string") return res.status(400).json({ error: "path (string) required" });
        if (rootPath.includes("..") || rootPath.includes("\0")) return res.status(400).json({ error: "Invalid path" });
        try {
            const proj = registerDynamicProject(name, rootPath, type ? { type } : {});
            if (persist) saveProject(name);
            res.status(201).json({ ok: true, name, type: proj.type, root: proj.root, persisted: !!persist });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    log.info("Job routes attached: POST /run  GET /status  GET /stream  GET /diff  POST /revert  POST /cancel  GET|POST /api/projects");
}
