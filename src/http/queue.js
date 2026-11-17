/**
 * src/http/queue.js
 *
 * Single-concurrency in-memory job queue with persistence.
 *
 * Improvements:
 *   - Job map cap: keeps only last 100 jobs to prevent memory leak
 *   - clearTimeout on timeout path before calling processNext (prevent double-fire)
 *   - Emit step-level progress events so IDE extensions see live updates
 *   - Persistent job store: jobs survive server restarts (via jobStore.js)
 *   - queueDepth included in "queued" SSE event so clients don't need a separate /queue poll
 */

import { createLogger } from "../core/logger.js";
import { config }       from "../core/config.js";
import { loadJobs, persistJobs } from "./jobStore.js";

const log = createLogger("queue");

const MAX_JOBS = 100;   // cap in-memory job history

const jobs  = new Map();
const queue = [];
let   running = false;

// Restore persisted jobs on module load (before any requests arrive)
loadJobs(jobs);

function makeId() {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── SSE subscriber registry ───────────────────────────────────────────────
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
    const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
    // Write to all subscribers; prune any that have closed (write throws)
    const alive = [];
    for (const res of list) {
        try {
            res.write(payload);
            alive.push(res);
        } catch {
            // Client disconnected — drop from list silently
        }
    }
    if (alive.length !== list.length) {
        if (alive.length === 0) subscribers.delete(jobId);
        else subscribers.set(jobId, alive);
    }
}

// ── Evict oldest completed/failed jobs when over cap ─────────────────
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
    emit(id, "queued", { id, position: queue.length, status: "pending", queueDepth: queue.length });
    persistJobs(jobs);
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

/**
 * Cancel a pending job (cannot cancel running jobs — they are async).
 * Returns true if cancelled, false if not found or already running/done.
 */
export function cancelJob(id) {
    const job = jobs.get(id);
    if (!job || job.status !== "pending") return false;
    job.status  = "failed";
    job.error   = "Cancelled by user";
    job.endedAt = Date.now();
    const idx = queue.indexOf(id);
    if (idx !== -1) queue.splice(idx, 1);
    emit(id, "failed", { id, error: job.error });
    persistJobs(jobs);
    log.info(`Job cancelled: ${id}`);
    return true;
}

/**
 * Graceful shutdown: mark all pending jobs failed and close all SSE connections.
 * Call this from SIGTERM/SIGINT handlers before process.exit().
 */
export function drainQueue() {
    // Fail all pending jobs so clients don't hang waiting
    for (const [id, job] of jobs.entries()) {
        if (job.status === "pending") {
            job.status  = "failed";
            job.error   = "Server shutting down";
            job.endedAt = Date.now();
            emit(id, "failed", { id, error: job.error });
        }
    }
    // Close all open SSE connections
    for (const [, list] of subscribers.entries()) {
        for (const res of list) {
            try { res.end(); } catch { /* already closed */ }
        }
    }
    subscribers.clear();
    queue.length = 0;
    try { persistJobs(jobs); } catch { /* ignore — we’re shutting down */ }
    log.info("Queue drained for shutdown");
}

// ── Queue concurrency mutex ───────────────────────────────────────
// processNext is called from multiple code-paths (setImmediate, timeout, etc.).
// A simple boolean `running` is not safe when Node’s microtask queue can
// re-enter before the flag is flipped. A locked Promise chain ensures only
// one processNext execution runs at a time.
let _processMutex = Promise.resolve();

async function processNext() {
    // Serialise all concurrent calls through a shared promise chain.
    // Each call chains onto the previous one, so they queue up and run one-by-one.
    _processMutex = _processMutex.then(_processNextImpl).catch(() => {});
    return _processMutex;
}

async function _processNextImpl() {
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
        persistJobs(jobs);
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
        persistJobs(jobs);

    } catch (err) {
        if (timeoutFired) return;
        clearTimeout(timeout);

        job.status  = "failed";
        job.error   = err.message || String(err);
        job.endedAt = Date.now();

        log.error(`Job failed: ${id} | error=${job.error}`);
        emit(id, "failed", { id, status: "failed", error: job.error });
        persistJobs(jobs);

    } finally {
        if (!timeoutFired) {
            running = false;
            setImmediate(processNext);
        }
    }
}
