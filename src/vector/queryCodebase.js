import { ChromaClient } from "chromadb";

const client = new ChromaClient({ host: "localhost", port: 8000 });
const cache  = {};

async function getCollection(project) {
    if (cache[project]) return cache[project];
    const name     = "codebase_" + project;
    cache[project] = await client.getCollection({ name });
    return cache[project];
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
