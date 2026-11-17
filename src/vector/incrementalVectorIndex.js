import { ChromaClient } from "chromadb";
import { CHROMA_HOST, CHROMA_PORT, EMBEDDING_VERSION } from "../core/constants.js";
import { AI_PROVIDER } from "../config/aiConfig.js";

let client;
try {
  client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
} catch {
  client = null;
}

export async function upsertFileVectors(project, filePath, chunks, embeddings) {
  // If no provider or no client → skip vector layer entirely
  if (!client || AI_PROVIDER === "none") return;

  try {
    const name = `codebase_${project}_${EMBEDDING_VERSION}`;
    let col;
    try {
      col = await client.getCollection({ name });
    } catch {
      col = await client.createCollection({ name, metadata: { "hnsw:space": "cosine" } });
    }

    await col.delete({ where: { filePath } }).catch(() => {});

    await col.add({
      ids: chunks.map((_, i) => `${filePath}_${i}`),
      documents: chunks,
      embeddings,
      metadatas: chunks.map(() => ({ filePath }))
    });
  } catch (e) {
    console.warn("[vector] skipped:", e.message);
  }
}
