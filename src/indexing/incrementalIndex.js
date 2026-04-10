import crypto from "crypto";
import { upsertFileVectors } from "../vector/incrementalVectorIndex.js";
import { embedText } from "../vector/embedder.js";

const fileHashes = new Map();

function hash(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

function chunk(content) {
  const size = 300;
  const chunks = [];
  for (let i = 0; i < content.length; i += size) {
    chunks.push(content.slice(i, i + size));
  }
  return chunks;
}

export async function smartIndex(project, filePath, content) {
  try {
    if (filePath.includes(".ai-dev-index-cache") || filePath.includes(".idea") || filePath.includes("node_modules")) return;

    const h = hash(content);
    if (fileHashes.get(filePath) === h) return;
    fileHashes.set(filePath, h);

    const chunks = chunk(content);

    // embeddings may be empty when provider=none → safe
    const limit = 5;
    const embeddings = [];
    for (let i = 0; i < chunks.length; i += limit) {
      const batch = chunks.slice(i, i + limit);
      const embs = await Promise.all(batch.map(c => embedText(c)));
      embeddings.push(...embs);
    }

    await upsertFileVectors(project, filePath, chunks, embeddings);

    console.log(`[smart-index] ok: ${filePath}`);
  } catch (e) {
    console.error("[smart-index-error]", e.message);
  }
}
