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
    MEMORY_MAX_SNIPPET
} from "../core/constants.js";

const client = new ChromaClient({ host: "localhost", port: 8000 });
const cache  = {};

async function getMemoryCollection(project) {
    if (cache[project]) return cache[project];
    const name        = MEMORY_COLLECTION_PREFIX + project;
    const collections = await client.listCollections();
    const exists      = collections.find(c => c.name === name);
    cache[project]    = exists
        ? await client.getCollection({ name })
        : await client.createCollection({ name, embeddingFunction: null });
    return cache[project];
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
    } catch (err) {
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
 * @returns {string|object[]}  formatted string (default) or array of structured entries
 */
export async function queryMemory(project, prompt, opts = {}) {
    const { returnStructured = false, filterType = null, minConfidence = 0 } = opts;

    try {
        const collection = await getMemoryCollection(project);
        const count      = await collection.count();
        if (count === 0) return returnStructured ? [] : "";

        // If prompt is empty just fetch most recent entries by count
        const embedding = prompt.length > 0
            ? await embed(prompt)
            : await embed("architecture pattern code");  // neutral fallback

        const nResults = Math.min(MEMORY_MAX_RESULTS + 2, count);  // fetch extras for filtering
        const results  = await collection.query({
            queryEmbeddings: [embedding],
            nResults,
            ...(filterType ? { where: { type: filterType } } : {})
        });

        const docs      = results.documents?.[0] || [];
        const metadatas = results.metadatas?.[0]  || [];

        // Parse entries, apply confidence filter, sort by confidence desc
        const entries = docs
            .map((doc, i) => {
                try {
                    const parsed = JSON.parse(doc);
                    parsed._meta = metadatas[i] || {};
                    return parsed;
                } catch {
                    // Legacy plain-text entry
                    return {
                        type: "general",
                        pattern: doc.substring(0, MEMORY_MAX_SNIPPET),
                        text: doc,
                        files: [],
                        confidence: 0.7,
                        _meta: metadatas[i] || {}
                    };
                }
            })
            .filter(e => (e.confidence || 0) >= minConfidence)
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
            .slice(0, MEMORY_MAX_RESULTS);

        if (returnStructured) return entries;

        // Format as injection-ready string
        if (entries.length === 0) return "";
        return entries
            .map(e => {
                let line = `[${e.type}] ${e.pattern || e.text}`;
                if (e.files?.length) line += ` (see: ${e.files.slice(0, 3).join(", ")})`;
                if (e.confidence) line += ` [conf: ${e.confidence.toFixed(1)}]`;
                return line;
            })
            .join("\n- ");

    } catch {
        return returnStructured ? [] : "";
    }
}
