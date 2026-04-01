/**
 * Intent-aware smart retriever.
 *
 * Pipeline:
 *   1. Intent classification   — classify prompt intent
 *   2. Intent-boosted scoring  — re-weight results by file-type relevance
 *   3. Deduplication           — drop near-identical chunks (Jaccard ≥ 0.8)
 *   4. Reranking               — sort by combined semantic + intent score
 *
 * Also exports classifyIntentFromPrompt() so agent.js can use the same
 * intent label for memory filtering without running retrieval again.
 */

import { queryCodebase } from "../vector/queryCodebase.js";
import { embed }         from "../vector/embedder.js";
import { indexProject }  from "../vector/runIndexCore.js";
import { getProject }    from "../core/projectRegistry.js";

const MAX_SNIPPET = 600;
const MAX_RESULTS = 5;
const FETCH_N     = 10;

// NOTE: the old module-level `indexing = false` flag was a concurrency bug:
// if two concurrent retrievals both found a missing index, the second one
// would skip indexing (flag already true) and then fail on queryCodebase again.
// Replaced by per-project deduplication in runIndexCore.js via requestDeduplicator.

// ─── Intent rules (shared with memory filtering) ─────────────────────────────────
const INTENT_RULES = [
    {
        label:    "ui",
        keywords: ["component", "page", "ui", "button", "form", "modal", "style", "css",
                   "layout", "render", "jsx", "tsx", "react", "frontend", "screen"],
        boost:    [".jsx", ".tsx", "component", "page", "layout", "style", "css"]
    },
    {
        label:    "api",
        keywords: ["api", "endpoint", "rest", "route", "controller", "service",
                   "repository", "fetch", "axios", "http", "service method"],
        boost:    ["controller", "service", "repository", "api", "route", ".java", "LocalService"]
    },
    {
        label:    "auth",
        keywords: ["login", "auth", "token", "jwt", "password", "session", "oauth", "permission", "role"],
        boost:    ["auth", "login", "token", "security", "permission", "role"]
    },
    {
        label:    "config",
        keywords: ["config", "env", "setting", "constant", "property", "yaml", "json", ".env"],
        boost:    ["config", "constant", ".json", ".yaml", ".env", "properties"]
    },
    {
        label:    "fix",
        keywords: ["fix", "bug", "error", "crash", "exception", "broken", "fail", "issue"],
        boost:    []
    }
];

/**
 * Classify intent from a prompt string.
 * Exported so agent.js can call this without triggering a full retrieval.
 */
export function classifyIntentFromPrompt(prompt) {
    const lower = prompt.toLowerCase();
    let bestLabel = "general";
    let bestScore = 0;
    for (const rule of INTENT_RULES) {
        const hits = rule.keywords.filter(kw => lower.includes(kw)).length;
        if (hits > bestScore) { bestScore = hits; bestLabel = rule.label; }
    }
    return bestLabel;
}

function getIntentRule(label) {
    return INTENT_RULES.find(r => r.label === label) || null;
}

// ─── Intent boost scorer ─────────────────────────────────────────────────────
function intentBoost(doc, rule) {
    if (!rule || rule.boost.length === 0) return 0;
    const lower   = doc.toLowerCase();
    const matches = rule.boost.filter(sig => lower.includes(sig)).length;
    return Math.min(0.3, matches * 0.1);
}

// ─── Deduplicator ──────────────────────────────────────────────────────────────
function tokenSet(text) {
    return new Set(text.toLowerCase().split(/\W+/).filter(t => t.length > 3));
}
function jaccardSimilarity(a, b) {
    const setA = tokenSet(a);
    const setB = tokenSet(b);
    const intersection = [...setA].filter(t => setB.has(t)).length;
    const union        = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
function deduplicate(docs, threshold = 0.8) {
    const kept = [];
    for (const doc of docs) {
        if (!kept.some(k => jaccardSimilarity(k, doc) >= threshold)) kept.push(doc);
    }
    return kept;
}

// ─── Compressor ──────────────────────────────────────────────────────────────
function compress(doc) {
    return doc && doc.length > MAX_SNIPPET ? doc.substring(0, MAX_SNIPPET) + "
..." : doc || "";
}

// ─── ExecutionState-aware scoring helpers ────────────────────────────────────

/**
 * Returns +0.25 score boost for docs from files that were recently modified.
 * Returns -999 (exclude) for docs from files already read (token waste).
 *
 * @param {string}         doc
 * @param {ExecutionState} execState
 */
function stateBoost(doc, execState) {
    if (!execState) return 0;
    const lowerDoc = doc.toLowerCase();

    // Boost modified files — they are the most relevant right now
    for (const modFile of execState.filesModified) {
        const base = modFile.split(/[\\/]/).pop().toLowerCase();
        if (base && lowerDoc.includes(base)) return 0.25;
    }

    // Penalise (but don't fully remove) already-read files — we already have that info
    for (const readFile of execState.filesRead) {
        const base = readFile.split(/[\\/]/).pop().toLowerCase();
        if (base && lowerDoc.includes(base)) return -0.4;
    }

    return 0;
}

// ─── Main retrieval entry point ───────────────────────────────────────────────
/**
 * Retrieve relevant code context.
 *
 * @param {string}          prompt
 * @param {string}          [project]
 * @param {ExecutionState}  [execState]   optional — enables state-aware scoring
 */
export async function retrieveContext(prompt, project = null, execState = null) {
    try {
        const embedding    = await embed(prompt);
        const intentLabel  = classifyIntentFromPrompt(prompt);
        const intentRule   = getIntentRule(intentLabel);

        if (intentLabel !== "general") console.error(`[retriever] Intent: ${intentLabel}`);

        let docs;
        try {
            docs = await queryCodebase(embedding, project, FETCH_N);
        } catch (err) {
            // Vector index missing or ChromaDB hiccup — build/rebuild automatically.
            // indexProject() is deduplicated internally: concurrent calls for the same
            // project share one build instead of launching parallel rebuilds.
            if (project) {
                console.error("
[retriever] Vector index missing or stale — rebuilding automatically...
");
                const projConfig = getProject(project);
                await indexProject(projConfig.root, project);
                console.error("
[retriever] Vector index rebuilt.
");
            }
            // Retry once after rebuild; if it still fails, return empty context
            try {
                docs = await queryCodebase(embedding, project, FETCH_N);
            } catch (retryErr) {
                console.error("[retriever] Index rebuild did not resolve query error:", retryErr.message);
                return "";
            }
        }

        if (!docs || docs.length === 0) return "";

        const scored = docs.map((doc, i) => ({
            doc,
            score: (1 - i / docs.length)
                + intentBoost(doc, intentRule)
                + stateBoost(doc, execState)
        }));

        // Filter out heavily penalised docs (score < 0 = not useful)
        const useful = scored.filter(s => s.score >= 0);
        if (execState && useful.length < scored.length) {
            console.error(`[retriever] ⚡ Skipped ${scored.length - useful.length} already-read chunk(s)`);
        }

        useful.sort((a, b) => b.score - a.score);
        const unique = deduplicate(useful.map(s => s.doc));
        return unique.slice(0, MAX_RESULTS).map(compress).join("

---

");

    } catch (err) {
        console.error("[retriever] Error:", err.message);
        return "";
    }
}
