import { ChromaClient } from "chromadb";

const client = new ChromaClient({ host: "localhost", port: 8000 });
const cache = {};

export async function getCollection(project) {
    if (cache[project]) return cache[project];

    const name = "codebase_" + project;
    const collections = await client.listCollections();
    const exists = collections.find(c => c.name === name);

    if (exists) {
        cache[project] = await client.getCollection({ name });
    } else {
        cache[project] = await client.createCollection({ name, embeddingFunction: null });
    }

    return cache[project];
}

export function clearCollectionCache(project) {
    delete cache[project];
}
