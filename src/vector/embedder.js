import { pipeline } from "@xenova/transformers";
import { EMBEDDING_MODEL } from "../core/constants.js";

let embedder = null;

// ─── Batch embed queue ───────────────────────────────────────────────────────────────────────────
// Coalesces multiple embed() calls that arrive in the same tick into one
// model invocation — cuts latency when memory + retriever both embed in parallel.
let batchQueue   = [];
let batchTimer   = null;
let isFlushing   = false;  // guard: prevents re-entrant / overlapping flushes
const BATCH_DELAY = 8;     // ms — collect calls within this window

function flushBatch() {
    batchTimer = null;
    if (isFlushing) {
        // A flush is already in-flight. Re-arm so items added during the flush
        // are picked up once the current batch completes.
        if (batchQueue.length > 0) batchTimer = setTimeout(flushBatch, BATCH_DELAY);
        return;
    }
    const items = batchQueue.splice(0);
    if (items.length === 0) return;

    isFlushing = true;
    // Fire one combined embed call for all queued texts
    getEmbedder().then(model => {
        const texts = items.map(i => i.text);
        return model(texts, { pooling: "mean", normalize: true });
    }).then(output => {
        // output.data is flat Float32Array [n_items × dim] — split per item
        const dim = output.data.length / items.length;
        items.forEach((item, i) => {
            item.resolve(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
        });
    }).catch(err => {
        items.forEach(item => item.reject(err));
    }).finally(() => {
        isFlushing = false;
        // Flush any items that queued up while we were busy
        if (batchQueue.length > 0 && !batchTimer) {
            batchTimer = setTimeout(flushBatch, BATCH_DELAY);
        }
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
