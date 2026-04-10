import { AI_PROVIDER, GEMINI_API_KEY, OLLAMA_URL, EMBED_MODEL } from "../config/aiConfig.js";
import { getCachedEmbedding, setCachedEmbedding } from "./embedCache.js";
import { getPersistentEmbedding, setPersistentEmbedding } from "./persistentEmbedCache.js";

async function embedWithOllama(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  });
  if (!res.ok) throw new Error("Ollama not reachable");
  const data = await res.json();
  return data.embedding || [];
}

async function embedWithGemini(text) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedText?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error("Gemini embed failed");
  const data = await res.json();
  return data.embedding?.values || [];
}

export async function embedText(text) {
  const key = text.slice(0, 200);

  const mem = getCachedEmbedding(key);
  if (mem) return mem;

  const disk = getPersistentEmbedding(key);
  if (disk) {
    setCachedEmbedding(key, disk);
    return disk;
  }

  try {
    let emb = [];
    if (AI_PROVIDER === "ollama") emb = await embedWithOllama(text);
    else if (AI_PROVIDER === "gemini") emb = await embedWithGemini(text);
    else return []; // provider=none → disable embeddings

    setCachedEmbedding(key, emb);
    setPersistentEmbedding(key, emb);
    return emb;
  } catch (e) {
    console.warn("[embed] disabled or failed:", e.message);
    return [];
  }
}
