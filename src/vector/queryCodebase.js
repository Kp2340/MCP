import { ChromaClient } from "chromadb";
import { CHROMA_HOST, CHROMA_PORT, EMBEDDING_VERSION } from "../core/constants.js";

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
let cache  = {};

async function getCollection(project) {
    if (cache[project]) return cache[project];
    // Versioned name matches the indexer — prevents querying stale vectors after model upgrade
    const name     = `codebase_${project}_${EMBEDDING_VERSION}`;
    try {
        cache[project] = await client.getCollection({ name });
        return cache[project];
    } catch (err) {
        delete cache[project];
        throw err;
    }
}

/**
 * Query the codebase vector collection.
 * @param {number[]} queryEmbedding
 * @param {string}   project
 * @param {number}   [nResults=6]  number of results to fetch (retriever may request more for reranking)
 */
export async function queryCodebase(queryEmbedding, project, nResults = 6) {
    const collection = await getCollection(project);
    const results    = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults
    });
    if (!results.documents || results.documents.length === 0) return [];
    return results.documents[0];
}
