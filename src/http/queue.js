/**
 * src/http/queue.js
 *
 * Single-concurrency in-memory job queue.
 *
 * Because the system runs on limited hardware (laptop GPU/CPU), only ONE
 * agent job runs at a time. All others wait in a FIFO queue.
 *
 * Job lifecycle:
 *   pending → running → completed | failed
 *
 * Job structure:
 *   {
 *     id:        string   (uuid-style)
 *     prompt:    string
 *     project:   string
 *     status:    "pending" | "running" | "completed" | "failed"
 *     createdAt: number   (ms timestamp)
 *     startedAt: number | null
 *     endedAt:   number | null
 *     result:    string | null   (final output text)
 *     error:     string | null
 *   }
 *
 * Usage:
 *   import { enqueue, getJob, getQueueStatus } from "./queue.js";
 */

import { createLogger } from "../core/logger.js";
import { config }       from "../core/config.js";

const log = createLogger("queue");

// ── State ────────────────────────────────────────────────────────────────────
const jobs  = new Map();   // id → job
const queue = [];          // pending job ids (FIFO)
let   running = false;     // true when a job is executing

// ── ID generator ─────────────────────────────────────────────────────────────
function makeId() {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── SSE subscriber registry ───────────────────────────────────────────────────
// Maps jobId → array of res objects (SSE connections watching that job)
const subscribers = new Map();

export function subscribeToJob(jobId, res) {
    if (!subscribers.has(jobId)) subscribers.set(jobId, []);
    subscribers.get(jobId).push(res);
    log.debug(`SSE subscriber added for job ${jobId} (total: ${subscribers.get(jobId).length})`);
}

export function unsubscribeFromJob(jobId, res) {
    const list = subscribers.get(jobId);
    if (!list) return;
    const idx = list.indexOf(res);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) subscribers.delete(jobId);
}

function emit(jobId, event, data) {
    const list = subscribers.get(jobId);
    if (!list || list.length === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of list) {
        try { res.write(payload); } catch { /* client disconnected */ }
    }
}

// ── Core queue logic ──────────────────────────────────────────────────────────

/**
 * Enqueue a new agent job.
 * @param {string} prompt
 * @param {string} project
 * @param {Function} runner  async (job) => string  — the actual agent work
 * @returns {object} job
 */
export function enqueue(prompt, project, runner) {
    const id  = makeId();
    const job = {
        id,
        prompt,
        project,
        status:    "pending",
        createdAt: Date.now(),
        startedAt: null,
        endedAt:   null,
        result:    null,
        error:     null,
        _runner:   runner   // internal — not exposed via API
    };
    jobs.set(id, job);
    queue.push(id);

    log.info(`Job enqueued: ${id} | project=${project} | queue_depth=${queue.length}`);
    emit(id, "queued", { id, position: queue.length, status: "pending" });

    // Kick off processing (no-op if already running)
    setImmediate(processNext);

    return job;
}

/**
 * Get a job by id.
 * Returns the public-facing view (no _runner).
 */
export function getJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const { _runner, ...pub } = job;
    return pub;
}

/**
 * Get overall queue status.
 */
export function getQueueStatus() {
    const pending = [...jobs.values()].filter(j => j.status === "pending").length;
    const runningJob = [...jobs.values()].find(j => j.status === "running");
    return {
        running:      !!runningJob,
        currentJobId: runningJob?.id || null,
        pending,
        total:        jobs.size
    };
}

/**
 * List all jobs (newest first), with optional status filter.
 */
export function listJobs(statusFilter = null) {
    return [...jobs.values()]
        .filter(j => !statusFilter || j.status === statusFilter)
        .map(({ _runner, ...pub }) => pub)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);  // cap at 50 for safety
}

// ── Processor ─────────────────────────────────────────────────────────────────
async function processNext() {
    if (running || queue.length === 0) return;

    const id  = queue.shift();
    const job = jobs.get(id);
    if (!job) { processNext(); return; }  // ghost entry — skip

    running       = true;
    job.status    = "running";
    job.startedAt = Date.now();

    log.info(`Job started: ${id} | project=${job.project}`);
    emit(id, "started", { id, status: "running", startedAt: job.startedAt });

    // Hard timeout — kill the job if it runs too long
    const timeout = setTimeout(() => {
        log.warn(`Job timed out: ${id}`);
        job.status  = "failed";
        job.error   = `Timed out after ${config.JOB_TIMEOUT_MS / 1000}s`;
        job.endedAt = Date.now();
        emit(id, "failed", { id, error: job.error });
        running = false;
        processNext();
    }, config.JOB_TIMEOUT_MS);

    try {
        const result  = await job._runner(job);
        clearTimeout(timeout);

        job.status  = "completed";
        job.result  = typeof result === "string" ? result : JSON.stringify(result);
        job.endedAt = Date.now();

        const duration = ((job.endedAt - job.startedAt) / 1000).toFixed(1);
        log.info(`Job completed: ${id} | duration=${duration}s`);
        emit(id, "completed", { id, status: "completed", result: job.result, duration });

    } catch (err) {
        clearTimeout(timeout);

        job.status  = "failed";
        job.error   = err.message || String(err);
        job.endedAt = Date.now();

        log.error(`Job failed: ${id} | error=${job.error}`);
        emit(id, "failed", { id, status: "failed", error: job.error });

    } finally {
        running = false;
        // Schedule next after a tick so the event loop breathes
        setImmediate(processNext);
    }
}
