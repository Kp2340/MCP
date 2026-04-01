import { ChromaClient } from "chromadb";
import { CHROMA_HOST, CHROMA_PORT, EMBEDDING_VERSION } from "../core/constants.js";
import { deduplicate, makeEmbedKey } from "../utils/requestDeduplicator.js";

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
let cache  = {};
let lastHeartbeat    = 0;
const HEARTBEAT_TTL  = 30_000;  // re-check ChromaDB liveness every 30 s

/**
 * Periodically verify ChromaDB is still reachable.
 * On failure: wipe the entire collection cache so the next call gets fresh handles.
 */
async function ensureConnected() {
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_TTL) return;   // still fresh
    try {
        await client.heartbeat();
        lastHeartbeat = now;
    } catch (err) {
        console.error("[queryCodebase] ChromaDB heartbeat failed, invalidating collection cache:", err.message);
        cache = {};            // drop all stale handles
        lastHeartbeat = now;   // prevent retry storm
    }
}

async function getCollection(project) {
    await ensureConnected();   // health-gate before every lookup

    if (cache[project]) return cache[project];

    // Versioned name matches the indexer — prevents querying stale vectors after model upgrade
    const name = `codebase_${project}_${EMBEDDING_VERSION}`;
    try {
        // Verify the collection actually exists before fetching
        const collections = await client.listCollections();
        const exists = collections.find(c => c.name === name);
        if (!exists) {
            throw new Error(
                `Vector index not found for project "${project}". ` +
                `Run: node src/vector/runIndex.js ${project}`
            );
        }
        cache[project] = await client.getCollection({ name });
        return cache[project];
    } catch (err) {
        delete cache[project];   // never cache a failed lookup
        throw err;
    }
}

/**
 * Query the codebase vector collection.
 * Concurrent calls with the same embedding+project+nResults share one ChromaDB round-trip.
 *
 * @param {number[]} queryEmbedding
 * @param {string}   project
 * @param {number}   [nResults=6]  number of results to fetch (retriever may request more for reranking)
 */
export function queryCodebase(queryEmbedding, project, nResults = 6) {
    // Deduplicate: identical parallel queries (same embedding prefix + project) share one DB call
    const key = makeEmbedKey(project, queryEmbedding, nResults);
    return deduplicate(key, async () => {
        const collection = await getCollection(project);
        const results    = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults
        });
        if (!results.documents || results.documents.length === 0) return [];
        return results.documents[0];
    });
}
