/**
 * src/http/queue.js
 *
 * Single-concurrency in-memory job queue.
 *
 * Improvements in MCP-3.11:
 *   - Job map cap: keeps only last 100 jobs to prevent memory leak on long-running server
 *   - clearTimeout on timeout path before calling processNext (prevent double-fire)
 *   - Emit step-level progress events so IDE extensions see live updates
 */

import { createLogger } from "../core/logger.js";
import { config }       from "../core/config.js";

const log = createLogger("queue");

const MAX_JOBS = 100;   // cap in-memory job history

const jobs  = new Map();
const queue = [];
let   running = false;

function makeId() {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── SSE subscriber registry ───────────────────────────────────────────────────
const subscribers = new Map();

export function subscribeToJob(jobId, res) {
    if (!subscribers.has(jobId)) subscribers.set(jobId, []);
    subscribers.get(jobId).push(res);
}

export function unsubscribeFromJob(jobId, res) {
    const list = subscribers.get(jobId);
    if (!list) return;
    const idx = list.indexOf(res);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) subscribers.delete(jobId);
}

export function emitJobStep(jobId, step, detail) {
    emit(jobId, "step", { step, detail, ts: Date.now() });
}

function emit(jobId, event, data) {
    const list = subscribers.get(jobId);
    if (!list || list.length === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of list) {
        try { res.write(payload); } catch { /* client disconnected */ }
    }
}

// ── Evict oldest completed/failed jobs when over cap ─────────────────────────
function evictOldJobs() {
    if (jobs.size <= MAX_JOBS) return;
    const terminal = [...jobs.entries()]
        .filter(([, j]) => j.status === "completed" || j.status === "failed")
        .sort(([, a], [, b]) => a.endedAt - b.endedAt);
    const toDelete = terminal.slice(0, jobs.size - MAX_JOBS);
    for (const [id] of toDelete) {
        jobs.delete(id);
        subscribers.delete(id);
    }
    if (toDelete.length > 0) log.debug(`Evicted ${toDelete.length} old jobs from memory`);
}

export function enqueue(prompt, project, runner) {
    evictOldJobs();
    const id  = makeId();
    const job = {
        id, prompt, project,
        status:    "pending",
        createdAt: Date.now(),
        startedAt: null,
        endedAt:   null,
        result:    null,
        error:     null,
        _runner:   runner
    };
    jobs.set(id, job);
    queue.push(id);
    log.info(`Job enqueued: ${id} | project=${project} | queue_depth=${queue.length}`);
    emit(id, "queued", { id, position: queue.length, status: "pending" });
    setImmediate(processNext);
    return job;
}

export function getJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const { _runner, ...pub } = job;
    return pub;
}

export function getQueueStatus() {
    const pending    = [...jobs.values()].filter(j => j.status === "pending").length;
    const runningJob = [...jobs.values()].find(j => j.status === "running");
    return { running: !!runningJob, currentJobId: runningJob?.id || null, pending, total: jobs.size };
}

export function listJobs(statusFilter = null) {
    return [...jobs.values()]
        .filter(j => !statusFilter || j.status === statusFilter)
        .map(({ _runner, ...pub }) => pub)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);
}

async function processNext() {
    if (running || queue.length === 0) return;

    const id  = queue.shift();
    const job = jobs.get(id);
    if (!job) { setImmediate(processNext); return; }

    running       = true;
    job.status    = "running";
    job.startedAt = Date.now();

    log.info(`Job started: ${id} | project=${job.project}`);
    emit(id, "started", { id, status: "running", startedAt: job.startedAt });

    let timeoutFired = false;
    const timeout = setTimeout(() => {
        timeoutFired    = true;
        job.status      = "failed";
        job.error       = `Timed out after ${config.JOB_TIMEOUT_MS / 1000}s`;
        job.endedAt     = Date.now();
        log.warn(`Job timed out: ${id}`);
        emit(id, "failed", { id, error: job.error });
        running = false;
        setImmediate(processNext);
    }, config.JOB_TIMEOUT_MS);

    try {
        const result = await job._runner(job);
        if (timeoutFired) return;  // timeout already resolved this job
        clearTimeout(timeout);

        job.status  = "completed";
        job.result  = typeof result === "string" ? result : JSON.stringify(result);
        job.endedAt = Date.now();

        const duration = ((job.endedAt - job.startedAt) / 1000).toFixed(1);
        log.info(`Job completed: ${id} | duration=${duration}s`);
        emit(id, "completed", { id, status: "completed", result: job.result, duration });

    } catch (err) {
        if (timeoutFired) return;
        clearTimeout(timeout);

        job.status  = "failed";
        job.error   = err.message || String(err);
        job.endedAt = Date.now();

        log.error(`Job failed: ${id} | error=${job.error}`);
        emit(id, "failed", { id, status: "failed", error: job.error });

    } finally {
        if (!timeoutFired) {
            running = false;
            setImmediate(processNext);
        }
    }
}
