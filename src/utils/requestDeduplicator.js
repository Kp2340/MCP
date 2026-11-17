/**
 * src/utils/requestDeduplicator.js
 *
 * Request Deduplicator
 *
 * Prevents duplicate concurrent async operations from running in parallel.
 * If two callers fire the same key at the same time, the second one receives
 * the same promise as the first — the underlying function runs exactly once.
 *
 * Typical use cases in this codebase:
 *   - Concurrent semantic search calls with identical embeddings
 *   - Multiple callers triggering project_index simultaneously
 *   - Parallel memory queries on the same project + prompt
 *
 * Usage:
 *   import { deduplicate } from "../utils/requestDeduplicator.js";
 *
 *   export async function queryCodebase(embedding, project, nResults = 6) {
 *       const key = `query:${project}:${embedding.slice(0, 4).join(",")}`;
 *       return deduplicate(key, () => _doQuery(embedding, project, nResults));
 *   }
 *
 * The key is a string that uniquely identifies the logical operation.
 * Build it from the function name + the arguments that determine the result.
 * Keep the key short — it is only held in memory for the duration of the call.
 *
 * Thread safety: Node.js is single-threaded, so Map operations are atomic.
 * The only race condition possible is micro-task interleaving inside `await`,
 * which this module handles correctly via the Map lookup-before-set pattern.
 */

/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/**
 * Execute asyncFn if no identical key is already in-flight.
 * If one is, return the existing promise instead of starting a new call.
 *
 * @template T
 * @param {string}           key      - Deduplication key
 * @param {() => Promise<T>} asyncFn  - Factory that produces the promise
 * @returns {Promise<T>}
 */
export function deduplicate(key, asyncFn) {
    if (inFlight.has(key)) {
        // A call with this exact key is already running — share its promise.
        return inFlight.get(key);
    }

    // Start the call and register it before any await point
    const promise = asyncFn().finally(() => {
        // Remove from map once settled (success OR error)
        inFlight.delete(key);
    });

    inFlight.set(key, promise);
    return promise;
}

/**
 * Return the number of currently in-flight deduplicated calls.
 * Useful for monitoring / tests.
 */
export function inFlightCount() {
    return inFlight.size;
}

/**
 * Build a short, stable deduplication key from a project name + query embedding.
 * Uses only the first 6 dimensions for performance — enough to distinguish queries.
 *
 * @param {string}   project
 * @param {number[]} embedding
 * @param {number}   [nResults]
 * @returns {string}
 */
export function makeEmbedKey(project, embedding, nResults = 6) {
    const prefix = embedding.slice(0, 6).map(v => v.toFixed(4)).join(",");
    return `embed:${project}:${nResults}:${prefix}`;
}
