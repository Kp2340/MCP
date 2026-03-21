import { pipeline } from "@xenova/transformers";
import { EMBEDDING_MODEL } from "../core/constants.js";

let embedder = null;

// ─── Batch embed queue ───────────────────────────────────────────────────────
// Coalesces multiple embed() calls that arrive in the same tick into one
// model invocation — cuts latency when memory + retriever both embed in parallel.
let batchQueue   = [];
let batchTimer   = null;
const BATCH_DELAY = 8;  // ms — collect calls within this window

function flushBatch() {
    batchTimer = null;
    const items = batchQueue.splice(0);
    if (items.length === 0) return;

    // Fire one combined embed call for all queued texts
    getEmbedder().then(model => {
        const texts = items.map(i => i.text);
        return model(texts, { pooling: "mean", normalize: true });
    }).then(output => {
        // output.data is flat [n_items × dim] — split per item
        const dim = output.data.length / items.length;
        items.forEach((item, i) => {
            item.resolve(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
        });
    }).catch(err => {
        items.forEach(item => item.reject(err));
    });
}

export async function getEmbedder() {
    if (!embedder) {
        embedder = await pipeline("feature-extraction", EMBEDDING_MODEL);
    }
    return embedder;
}

/**
 * Embed a single text. Calls are automatically batched within an 8ms window.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export function embed(text) {
    return new Promise((resolve, reject) => {
        batchQueue.push({ text, resolve, reject });
        if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_DELAY);
    });
}