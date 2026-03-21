import { ChromaClient } from "chromadb";
import { CHROMA_HOST, CHROMA_PORT, EMBEDDING_VERSION } from "../core/constants.js";

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
let cache = {};

/**
 * Get or create the versioned codebase vector collection.
 * Name includes EMBEDDING_VERSION so model upgrades auto-create a fresh collection
 * instead of querying incompatible stale vectors.
 */
export async function getCollection(project) {
    if (cache[project]) return cache[project];

    const name        = `codebase_${project}_${EMBEDDING_VERSION}`;
    const collections = await client.listCollections();
    const exists      = collections.find(c => c.name === name);

    cache[project] = exists
        ? await client.getCollection({ name })
        : await client.createCollection({ name, embeddingFunction: null });

    return cache[project];
}

/** Invalidate a cached handle — call after ChromaDB reconnect. */
export function invalidateCollectionCache(project) {
    if (project) delete cache[project];
    else cache = {};
}