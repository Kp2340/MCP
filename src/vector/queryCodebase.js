import { ChromaClient } from "chromadb";

const client = new ChromaClient({
    host: "localhost",
    port: 8000
});

const cache = {};

async function getCollection(project) {

    if (cache[project]) return cache[project];

    const name = "codebase_" + project;

    cache[project] = await client.getCollection({
        name
    });

    return cache[project];
}

export async function queryCodebase(queryEmbedding, project) {

    const collection = await getCollection(project);

    const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: 6
    });

    if (!results.documents || results.documents.length === 0) {
        return [];
    }

    return results.documents[0];
}