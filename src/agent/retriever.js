/**
 * Intent-aware smart retriever.
 *
 * Upgrades from the naive "embed → top-4 → truncate" approach to:
 *   1. Intent classification   — what kind of code is the prompt about?
 *   2. Intent-boosted scoring  — re-weight results by file-type relevance
 *   3. Deduplication           — drop near-identical chunks (Jaccard ≥ 0.8)
 *   4. Reranking               — sort by combined semantic + intent score
 */

import { queryCodebase } from "../vector/queryCodebase.js";
import { embed }         from "../vector/embedder.js";
import { indexProject }  from "../vector/runIndexCore.js";
import { getProject }    from "../core/projectRegistry.js";

const MAX_SNIPPET = 600;
const MAX_RESULTS = 5;       // fetch more then rerank down to this
const FETCH_N     = 10;      // fetch extra candidates for reranking

let indexing = false;

// ─── Intent classifier ───────────────────────────────────────────────────────
// Maps prompt keywords to an intent label and a set of high-signal file
// patterns that should score higher for that intent.
const INTENT_RULES = [
    {
        label:    "ui",
        keywords: ["component", "page", "ui", "button", "form", "modal", "style", "css", "layout", "render", "jsx", "tsx", "react", "frontend"],
        boost:    [".jsx", ".tsx", "component", "page", "layout", "style", "css"]
    },
    {
        label:    "api",
        keywords: ["api", "endpoint", "rest", "route", "controller", "service", "repository", "fetch", "axios", "http"],
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
        boost:    []   // no file-type preference — all files equally relevant
    }
];

function classifyIntent(prompt) {
    const lower = prompt.toLowerCase();
    let bestLabel = "general";
    let bestScore = 0;

    for (const rule of INTENT_RULES) {
        const hits = rule.keywords.filter(kw => lower.includes(kw)).length;
        if (hits > bestScore) {
            bestScore = hits;
            bestLabel = rule.label;
        }
    }

    return { label: bestLabel, rule: INTENT_RULES.find(r => r.label === bestLabel) || null };
}

// ─── Intent boost scorer ─────────────────────────────────────────────────────
// Returns an additional score (0.0–0.3) for a doc based on whether its text
// contains file-type signals matching the intent.
function intentBoost(doc, rule) {
    if (!rule || rule.boost.length === 0) return 0;
    const lower   = doc.toLowerCase();
    const matches = rule.boost.filter(sig => lower.includes(sig)).length;
    return Math.min(0.3, matches * 0.1);
}

// ─── Deduplicator (Jaccard on token sets) ────────────────────────────────────
function tokenSet(text) {
    return new Set(text.toLowerCase().split(/\W+/).filter(t => t.length > 3));
}

function jaccardSimilarity(a, b) {
    const setA = tokenSet(a);
    const setB = tokenSet(b);
    const intersection = [...setA].filter(t => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

function deduplicate(docs, threshold = 0.8) {
    const kept = [];
    for (const doc of docs) {
        const isDuplicate = kept.some(k => jaccardSimilarity(k, doc) >= threshold);
        if (!isDuplicate) kept.push(doc);
    }
    return kept;
}

// ─── Snippet compressor ───────────────────────────────────────────────────────
function compress(doc) {
    if (!doc) return "";
    return doc.length > MAX_SNIPPET ? doc.substring(0, MAX_SNIPPET) + "\n..." : doc;
}

// ─── Main retrieval entry point ───────────────────────────────────────────────
export async function retrieveContext(prompt, project = null) {
    try {
        const embedding = await embed(prompt);
        const intent    = classifyIntent(prompt);

        if (intent.label !== "general") {
            console.error(`[retriever] Intent: ${intent.label}`);
        }

        let docs;
        try {
            docs = await queryCodebase(embedding, project, FETCH_N);
        } catch {
            // Collection missing — auto-build index once
            if (project && !indexing) {
                indexing = true;
                console.error("\n[retriever] Vector index missing. Building automatically...\n");
                const config = getProject(project);
                await indexProject(config.root, project);
                console.error("\n[retriever] Vector index built.\n");
                indexing = false;
            }
            docs = await queryCodebase(embedding, project, FETCH_N);
        }

        if (!docs || docs.length === 0) return "";

        // 1. Score = base rank score (inverted position) + intent boost
        const scored = docs.map((doc, i) => ({
            doc,
            score: (1 - i / docs.length) + intentBoost(doc, intent.rule)
        }));

        // 2. Sort by combined score descending
        scored.sort((a, b) => b.score - a.score);

        // 3. Deduplicate near-identical chunks
        const unique = deduplicate(scored.map(s => s.doc));

        // 4. Take top MAX_RESULTS and compress
        return unique.slice(0, MAX_RESULTS).map(compress).join("\n\n---\n\n");

    } catch (err) {
        console.error("[retriever] Error:", err.message);
        return "";
    }
}
