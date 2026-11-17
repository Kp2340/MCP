/**
 * src/training/formatter.js
 *
 * Converts raw agent run data (runs.jsonl) into clean fine-tuning datasets.
 *
 * Two output formats:
 *   1. hf_chat   — Hugging Face messages format (default, for Unsloth/TRL)
 *   2. alpaca    — Alpaca instruction format (for llama.cpp / older pipelines)
 *
 * Usage:
 *   node src/training/formatter.js [--format hf_chat|alpaca] [--min-quality 0.7]
 *
 * Filters applied:
 *   - Write-tool examples only (apply_changes, str_replace, apply_patch)
 *   - Minimum quality score (computed from tool type + context length + dedup)
 *   - De-duplication using fingerprint field from collector
 *   - Maximum context length guard (prevents oversized training examples)
 *
 * Output:
 *   src/training/dataset/train.jsonl    — training split (80%)
 *   src/training/dataset/eval.jsonl     — eval split (20%)
 *   src/training/dataset/stats.json     — dataset statistics
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const DATASET_DIR   = path.join(__dirname, "dataset");
const INPUT_FILE    = path.join(DATASET_DIR, "runs.jsonl");
const TRAIN_FILE    = path.join(DATASET_DIR, "train.jsonl");
const EVAL_FILE     = path.join(DATASET_DIR, "eval.jsonl");
const STATS_FILE    = path.join(DATASET_DIR, "stats.json");

// Write tools produce the training signal we care about
const WRITE_TOOLS = new Set([
    "project_apply_changes",
    "project_str_replace",
    "project_apply_patch"
]);

// Max chars per user message before it's considered too noisy
const MAX_USER_CHARS = 4000;

// ── Quality scorer ────────────────────────────────────────────────────────────

/**
 * Score an example 0.0–1.0. Higher = better training signal.
 * Criteria:
 *   - Is a write tool (essential): +0.5
 *   - Context is non-trivial (> 200 chars): +0.2
 *   - Short context (< 500 chars, may be shallow): –0.1
 *   - str_replace (most precise tool): +0.15
 *   - apply_changes (full file, less precise): +0.1
 *   - Apply patch (targeted): +0.12
 *   - User message not too long (< MAX_USER_CHARS): +0.15
 */
function scoreExample(example) {
    const meta = example._meta || {};
    let score = 0;

    if (meta.isWrite)             score += 0.5;

    const userMsg = example.messages?.find(m => m.role === "user")?.content || "";
    const ctxLen  = userMsg.length;

    if (ctxLen > 200)             score += 0.2;
    if (ctxLen < 500)             score -= 0.1;
    if (ctxLen > MAX_USER_CHARS)  score -= 0.3;  // too noisy

    const tool = meta.tool || "";
    if (tool === "project_str_replace")    score += 0.15;
    if (tool === "project_apply_changes")  score += 0.10;
    if (tool === "project_apply_patch")    score += 0.12;

    return Math.max(0, Math.min(1, score));
}

// ── Format converters ─────────────────────────────────────────────────────────

/**
 * Hugging Face chat format — what Unsloth + TRL expects.
 * Each example is already in messages format; we just validate and re-emit.
 */
function toHFChat(example) {
    return {
        messages: example.messages,
        _meta:    example._meta
    };
}

/**
 * Alpaca instruction format:
 *   { instruction, input, output }
 * For older pipelines that don't support chat format.
 */
function toAlpaca(example) {
    const system  = example.messages?.find(m => m.role === "system")?.content  || "";
    const user    = example.messages?.find(m => m.role === "user")?.content    || "";
    const asst    = example.messages?.find(m => m.role === "assistant")?.content || "";
    return {
        instruction: system,
        input:       user,
        output:      asst,
        _meta:       example._meta
    };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export function formatDataset(opts = {}) {
    const format     = opts.format     || "hf_chat";
    const minQuality = opts.minQuality ?? 0.6;
    const verbose    = opts.verbose    ?? true;

    if (!fs.existsSync(INPUT_FILE)) {
        throw new Error(
            `No training data found at ${INPUT_FILE}\n` +
            "Run the agent with COLLECT_TRAINING_DATA=1 to collect examples first."
        );
    }

    const raw = fs.readFileSync(INPUT_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line, i) => {
            try   { return JSON.parse(line); }
            catch { if (verbose) console.warn(`[formatter] Skipping malformed line ${i + 1}`); return null; }
        })
        .filter(Boolean);

    if (verbose) console.log(`[formatter] Loaded ${raw.length} raw examples`);

    // Step 1: deduplicate by fingerprint
    const seenFingerprints = new Set();
    const deduped = raw.filter(ex => {
        const fp = ex._meta?.fingerprint;
        if (!fp) return true;  // no fingerprint → keep
        if (seenFingerprints.has(fp)) return false;
        seenFingerprints.add(fp);
        return true;
    });
    if (verbose) console.log(`[formatter] After dedup: ${deduped.length} examples`);

    // Step 2: quality filter
    const scored = deduped
        .map(ex => ({ ex, score: scoreExample(ex) }))
        .filter(({ score }) => score >= minQuality);
    if (verbose) console.log(`[formatter] After quality filter (>=${minQuality}): ${scored.length} examples`);

    // Step 3: context length guard
    const sizeFiltered = scored.filter(({ ex }) => {
        const userMsg = ex.messages?.find(m => m.role === "user")?.content || "";
        return userMsg.length <= MAX_USER_CHARS;
    });
    if (verbose) console.log(`[formatter] After size filter: ${sizeFiltered.length} examples`);

    // Step 4: convert to target format
    const converter = format === "alpaca" ? toAlpaca : toHFChat;
    const converted = sizeFiltered.map(({ ex, score }) => ({
        ...converter(ex),
        _quality: parseFloat(score.toFixed(3))
    }));

    // Step 5: shuffle then split 80/20
    const shuffled = converted.sort(() => Math.random() - 0.5);
    const splitIdx = Math.floor(shuffled.length * 0.8);
    const train    = shuffled.slice(0, splitIdx);
    const evalSet  = shuffled.slice(splitIdx);

    // Step 6: write outputs
    fs.mkdirSync(DATASET_DIR, { recursive: true });
    fs.writeFileSync(TRAIN_FILE, train.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
    fs.writeFileSync(EVAL_FILE,  evalSet.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // Step 7: write stats
    const toolCounts = {};
    converted.forEach(ex => {
        const tool = ex._meta?.tool || "unknown";
        toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    });
    const avgQuality = converted.length > 0
        ? (converted.reduce((s, e) => s + (e._quality || 0), 0) / converted.length).toFixed(3)
        : 0;

    const stats = {
        generatedAt:   new Date().toISOString(),
        format,
        rawExamples:   raw.length,
        afterDedup:    deduped.length,
        afterQuality:  sizeFiltered.length,
        trainExamples: train.length,
        evalExamples:  evalSet.length,
        avgQuality,
        toolCounts,
        minQuality,
        outputFiles: { train: TRAIN_FILE, eval: EVAL_FILE }
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");

    if (verbose) {
        console.log("\n[formatter] ✅ Dataset ready:");
        console.log(`  Train: ${train.length} examples → ${TRAIN_FILE}`);
        console.log(`  Eval:  ${evalSet.length} examples → ${EVAL_FILE}`);
        console.log(`  Avg quality score: ${avgQuality}`);
        console.log(`  Tool breakdown: ${JSON.stringify(toolCounts)}`);
    }

    return stats;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].includes("formatter")) {
    const args       = process.argv.slice(2);
    const fmtIdx     = args.indexOf("--format");
    const qualIdx    = args.indexOf("--min-quality");
    const format     = fmtIdx !== -1     ? args[fmtIdx + 1]     : "hf_chat";
    const minQuality = qualIdx !== -1    ? parseFloat(args[qualIdx + 1]) : 0.6;

    try {
        formatDataset({ format, minQuality });
    } catch (err) {
        console.error("[formatter] Error:", err.message);
        process.exit(1);
    }
}
