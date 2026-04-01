/**
 * Structured long-term memory layer.
 *
 * Each memory entry is stored as a JSON object with typed fields:
 *   {
 *     type:       "architecture" | "fix" | "pattern" | "convention" | "general",
 *     pattern:    string  — the main knowledge statement (max 200 chars)
 *     files:      string[] — relevant filenames (max 5)
 *     confidence: number  — 0.0–1.0
 *     tag:        string  — caller-supplied tag
 *     ts:         number  — Unix timestamp ms
 *   }
 *
 * Plain-text entries from older versions are read back transparently
 * via the `text` field fallback.
 */

import { ChromaClient } from "chromadb";
import { embed } from "./embedder.js";
import {
    MEMORY_COLLECTION_PREFIX,
    MEMORY_MAX_RESULTS,
    MEMORY_MAX_SNIPPET,
    MEMORY_MAX_ENTRIES,
    MEMORY_EVICT_BATCH,
    MEMORY_QUERY_LIMIT,
    CHROMA_HOST,
    CHROMA_PORT,
    EMBEDDING_VERSION
} from "../core/constants.js";

const client = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
// cache is keyed per-project and reset if ChromaDB reconnects
let cache  = {};

// Invalidate cache entries on connection error so stale handles are dropped
function invalidateCache(project) {
    if (project) delete cache[project];
    else cache = {};
}

async function getMemoryCollection(project) {
    if (cache[project]) return cache[project];
    // Collection name is versioned by embedding model version to prevent stale vector reuse
    const name        = `${MEMORY_COLLECTION_PREFIX}${project}_${EMBEDDING_VERSION}`;
    try {
        const collections = await client.listCollections();
        const exists      = collections.find(c => c.name === name);
        cache[project]    = exists
            ? await client.getCollection({ name })
            : await client.createCollection({ name, embeddingFunction: null });
        return cache[project];
    } catch (err) {
        invalidateCache(project);
        throw err;
    }
}

/**
 * Evict lowest-scoring entries when collection exceeds MEMORY_MAX_ENTRIES.
 * Runs asynchronously after store — does not block the caller.
 */
async function evictIfNeeded(collection) {
    try {
        const count = await collection.count();
        if (count <= MEMORY_MAX_ENTRIES) return;

        // Fetch a capped sample of metadatas to find lowest confidence x recency score.
        // MEMORY_QUERY_LIMIT prevents unbounded memory fetch on large collections.
        const all  = await collection.get({ include: ["metadatas"], limit: MEMORY_QUERY_LIMIT });
        const now  = Date.now();
        const scored = (all.ids || []).map((id, i) => {
            const meta  = all.metadatas?.[i] || {};
            const conf  = meta.confidence || 0.5;
            const ageMs = now - (meta.ts || 0);
            const score = conf / (1 + ageMs / 86400000);  // decay by day
            return { id, score };
        }).sort((a, b) => a.score - b.score);

        const toDelete = scored.slice(0, MEMORY_EVICT_BATCH).map(s => s.id);
        if (toDelete.length > 0) {
            await collection.delete({ ids: toDelete });
            console.error(`[memory] Evicted ${toDelete.length} low-score entries`);
        }
    } catch (err) {
        console.error("[memory] Eviction error:", err.message);
    }
}

/**
 * Store a structured memory entry.
 *
 * @param {string} project
 * @param {object|string} data
 *   Pass a string for backward compat (stored as { type:"general", pattern: text }).
 *   Pass an object: { type, pattern, files?, confidence? }
 * @param {string} [tag]
 */
export async function storeMemory(project, data, tag = "general") {
    try {
        // Normalise to structured object
        const entry = (typeof data === "string")
            ? { type: "general", pattern: data, files: [], confidence: 0.8 }
            : {
                type:       data.type       || "general",
                pattern:    data.pattern    || data.text || "",
                files:      Array.isArray(data.files) ? data.files.slice(0, 5) : [],
                confidence: typeof data.confidence === "number" ? data.confidence : 0.8
            };

        if (!entry.pattern || entry.pattern.length < 10) return;  // skip noise

        entry.tag = tag;
        entry.ts  = Date.now();

        const text      = entry.pattern;  // embed the pattern text for semantic search
        const embedding = await embed(text);
        const id        = Buffer.from(text.substring(0, 180) + entry.ts)
            .toString("base64").substring(0, 512);

        const collection = await getMemoryCollection(project);
        await collection.add({
            ids:        [id],
            documents:  [JSON.stringify(entry)],   // store full struct as document
            embeddings: [embedding],
            metadatas:  [{ tag, type: entry.type, ts: entry.ts, confidence: entry.confidence }]
        });

        console.error(`[memory] Stored (${entry.type}): ${text.substring(0, 80)}`);
        // Evict in background — do not await, never blocks the agent
        evictIfNeeded(collection).catch(() => {});
    } catch (err) {
        invalidateCache(project);
        console.error("[memory] storeMemory error:", err.message);
    }
}

/**
 * Query memory for entries relevant to a prompt.
 *
 * @param {string}  project
 * @param {string}  prompt
 * @param {object}  [opts]
 * @param {boolean} [opts.returnStructured=false]  if true → return parsed objects array
 * @param {string}  [opts.filterType]              optional type filter (e.g. "architecture")
 * @param {number}  [opts.minConfidence=0]         skip entries below this confidence
 * @param {object}  [opts.execState]               ExecutionState — enables file-overlap scoring
 * @param {string}  [opts.intent]                  current intent — enables intent-match scoring
 * @returns {string|object[]}  formatted string (default) or array of structured entries
 */
export async function queryMemory(project, prompt, opts = {}) {
    const { returnStructured = false, filterType = null, minConfidence = 0, execState = null, intent = null } = opts;

    try {
        const collection = await getMemoryCollection(project);
        const count      = await collection.count();
        if (count === 0) return returnStructured ? [] : "";

        // If prompt is empty just fetch most recent entries by count
        const embedding = prompt.length > 0
            ? await embed(prompt)
            : await embed("architecture pattern code");  // neutral fallback

        const nResults = Math.min(MEMORY_MAX_RESULTS + 4, count);  // fetch extras for re-ranking
        const results  = await collection.query({
            queryEmbeddings: [embedding],
            nResults,
            ...(filterType ? { where: { type: filterType } } : {})
        });

        const docs      = results.documents?.[0] || [];
        const distances = results.distances?.[0]  || [];
        const metadatas = results.metadatas?.[0]  || [];

        // Parse entries
        const entries = docs.map((doc, i) => {
            let parsed;
            try {
                parsed = JSON.parse(doc);
            } catch {
                parsed = {
                    type: "general",
                    pattern: doc.substring(0, MEMORY_MAX_SNIPPET),
                    text: doc,
                    files: [],
                    confidence: 0.7
                };
            }
            parsed._meta     = metadatas[i] || {};
            parsed._distance = distances[i]  || 1.0;  // lower = more similar
            return parsed;
        });

        // Build read-file set from execState for overlap scoring (MCP-3.5)
        const readFiles = execState ? [...execState.filesRead].map(f => f.split(/[\/\\]/).pop().toLowerCase()) : [];

        // Deduplication helper (Jaccard on pattern tokens)
        const tokenSet = (text) => new Set((text || '').toLowerCase().split(/\W+/).filter(t => t.length > 3));
        const jaccard  = (a, b) => {
            const sa = tokenSet(a), sb = tokenSet(b);
            const inter = [...sa].filter(t => sb.has(t)).length;
            const union = new Set([...sa, ...sb]).size;
            return union === 0 ? 0 : inter / union;
        };

        // Composite scoring with recency, error relevance, and time-decay
        const now = Date.now();
        const scored = entries
            .filter(e => (e.confidence || 0) >= minConfidence)
            .map(e => {
                const semanticScore  = 1 - (e._distance || 0);
                const fileOverlap    = readFiles.length > 0 && Array.isArray(e.files)
                    ? e.files.filter(f => readFiles.includes(f.split(/[\/\\]/).pop().toLowerCase())).length * 0.3
                    : 0;
                const intentTypes    = { ui: 'architecture', api: 'architecture', fix: 'fix', auth: 'fix', config: 'architecture' };
                const expectedType   = intentTypes[intent] || null;
                const intentMatch    = (expectedType && e.type === expectedType) ? 0.2 : 0;
                const ageMs          = now - (e.ts || e._meta?.ts || 0);
                const recency        = ageMs < 86400000 ? 0.2 : ageMs < 604800000 ? 0.1 : 0;
                const hasActiveError = execState && execState.errors.length > 0;
                const errorRelevance = (hasActiveError && e.type === 'fix') ? 0.3 : 0;
                const decayFactor    = Math.pow(0.95, ageMs / (7 * 86400000));
                const rawScore       = semanticScore + fileOverlap + intentMatch + recency + errorRelevance;
                return { ...e, _score: rawScore * decayFactor };
            })
            .sort((a, b) => b._score - a._score);

        // Deduplicate: keep best, drop near-duplicates (Jaccard >= 0.8)
        const deduped = [];
        for (const entry of scored) {
            const pat   = entry.pattern || entry.text || '';
            const isDup = deduped.some(k => jaccard(k.pattern || k.text || '', pat) >= 0.8);
            if (!isDup) deduped.push(entry);
            if (deduped.length >= MEMORY_MAX_RESULTS) break;
        }

        if (returnStructured) return deduped;

        // Format as injection-ready string
        if (deduped.length === 0) return "";
        return deduped
            .map(e => {
                let line = `[${e.type}] ${e.pattern || e.text}`;
                if (e.files?.length) line += ` (see: ${e.files.slice(0, 3).join(", ")})`;
                if (e.confidence) line += ` [conf: ${e.confidence.toFixed(1)}]`;
                return line;
            })
            .join("- ");


    } catch (err) {
        console.error("[memory] queryMemory error:", err.message);
        return returnStructured ? [] : "";
    }
}


