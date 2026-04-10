import { ChromaClient } from "chromadb";
import { CHROMA_HOST, CHROMA_PORT, EMBEDDING_VERSION } from "../core/constants.js";
import { deduplicate, makeEmbedKey } from "../utils/requestDeduplicator.js";

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
let cache  = {};
let lastHeartbeat    = 0;
const HEARTBEAT_TTL  = 30_000;

async function ensureConnected() {
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_TTL) return;
    try {
        try {
            await client.heartbeat();
            lastHeartbeat = now;
        } catch (e) {
            console.warn("[vector] ChromaDB not reachable, switching to degraded mode");
            cache = {};
            lastHeartbeat = now;
            return;
        }
    } catch (err) {
        console.error("[queryCodebase] ChromaDB heartbeat failed, invalidating cache:", err.message);
        cache = {};
        lastHeartbeat = now;
    }
}

async function getCollection(project) {
    await ensureConnected();

    if (cache[project]) return cache[project];

    const name = `codebase_${project}_${EMBEDDING_VERSION}`;

    try {
        const collections = await client.listCollections();
        const exists = collections.find(c => c.name === name);

        if (!exists) {
            console.warn(`[vector] Missing index for ${project}, falling back to empty results`);
            return null;
        }

        cache[project] = await client.getCollection({ name });
        return cache[project];
    } catch (err) {
        delete cache[project];
        return null;
    }
}

export function queryCodebase(queryEmbedding, project, nResults = 6) {
    const key = makeEmbedKey(project, queryEmbedding, nResults);

    return deduplicate(key, async () => {
        const collection = await getCollection(project);

        if (!collection) return [];

        let results;
        try {
            results = await collection.query({
                queryEmbeddings: [queryEmbedding],
                nResults
            });
        } catch (e) {
            console.warn("[vector] Query failed, returning fallback empty results");
            return [];
        }

        if (!results.documents || results.documents.length === 0) return [];
        return results.documents[0];
    });
}
