/**
 * src/http/jobStore.js
 *
 * Persistent job store — backs the in-memory job map with a JSON file
 * so completed/pending jobs survive server restarts.
 *
 * Layout:
 *   data/jobs.json  — array of serialised job objects (last 200)
 *
 * On startup  : loadJobs() restores the map from disk.
 * On mutation  : persistJobs() writes atomically (write temp → rename).
 * On recovery  : any job that was "running" at crash time is reset to
 *                "failed" with error "Server restarted" — prevents ghost jobs.
 *
 * This file owns the persistent side.  queue.js owns the runtime side
 * (in-memory Map, SSE subscribers, processNext loop).  queue.js calls
 * persistJobs() after every state change.
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../core/logger.js";

const log = createLogger("job-store");

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "../../data");
const STORE_FILE = path.join(DATA_DIR, "jobs.json");
const TEMP_FILE  = STORE_FILE + ".tmp";
const MAX_PERSIST = 200;

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Load persisted jobs from disk into the provided Map.
 * Jobs that were mid-run at crash time are marked failed.
 *
 * @param {Map} jobsMap   — the runtime jobs Map in queue.js
 */
export function loadJobs(jobsMap) {
    if (!fs.existsSync(STORE_FILE)) return;
    try {
        const raw  = fs.readFileSync(STORE_FILE, "utf-8");
        const list = JSON.parse(raw);
        let restored = 0;
        let recovered = 0;
        for (const job of list) {
            if (!job?.id) continue;
            // Jobs that were running when the server died — mark as failed
            if (job.status === "running" || job.status === "pending") {
                job.status  = "failed";
                job.error   = "Server restarted — job was interrupted";
                job.endedAt = job.endedAt || Date.now();
                recovered++;
            }
            // Never restore the runner function — it cannot be serialised
            delete job._runner;
            jobsMap.set(job.id, job);
            restored++;
        }
        log.info(`Restored ${restored} job(s) from disk (${recovered} recovered from crash)`);
    } catch (err) {
        log.warn(`Could not load jobs from disk: ${err.message}`);
    }
}

/**
 * Write the current job map to disk (atomic write via temp file).
 * Silently skips the _runner function — it is not serialisable.
 *
 * @param {Map} jobsMap
 */
export function persistJobs(jobsMap) {
    try {
        // Take only the last MAX_PERSIST terminal jobs + all active ones
        const all      = [...jobsMap.values()];
        const active   = all.filter(j => j.status === "pending" || j.status === "running");
        const terminal = all
            .filter(j => j.status === "completed" || j.status === "failed")
            .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
            .slice(0, MAX_PERSIST - active.length);

        const toWrite = [...active, ...terminal].map(j => {
            const { _runner, ...safe } = j;
            return safe;
        });

        fs.writeFileSync(TEMP_FILE, JSON.stringify(toWrite, null, 2), "utf-8");
        fs.renameSync(TEMP_FILE, STORE_FILE);
    } catch (err) {
        log.warn(`persistJobs failed: ${err.message}`);
    }
}
