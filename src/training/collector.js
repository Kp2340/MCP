/**
 * Training data collector.
 *
 * Wraps agent runs and logs every successful (step -> tool call -> result)
 * triple to a JSONL file. These examples are used later to fine-tune
 * a private model on your team's coding patterns.
 *
 * To enable: set env var  COLLECT_TRAINING_DATA=1  before running the agent.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_DIR  = path.join(__dirname, "dataset");
const DATASET_FILE = path.join(DATASET_DIR, "runs.jsonl");
const ENABLED      = process.env.COLLECT_TRAINING_DATA === "1";

const SYSTEM_PROMPT =
    "You are an AI coding agent. Given a task step and code context, " +
    "output ONLY a JSON tool call. No explanation, no markdown.";

if (ENABLED) {
    fs.mkdirSync(DATASET_DIR, { recursive: true });
    console.error("[collector] Training data collection ENABLED");
    console.error("[collector] Writing to:", DATASET_FILE);
}

/**
 * TrainingCollector — class interface used by agent.js.
 * Tracks a single agent run and persists successful steps to JSONL.
 */
export class TrainingCollector {

    constructor() {
        this._prompt = null;
        this._steps  = [];
    }

    /** Returns number of examples already on disk. */
    count() {
        if (!fs.existsSync(DATASET_FILE)) return 0;
        return fs.readFileSync(DATASET_FILE, "utf8")
            .split("\n")
            .filter(Boolean)
            .length;
    }

    /** Called at the start of a new agent run. */
    startRun(prompt) {
        this._prompt = prompt;
        this._steps  = [];
    }

    /**
     * Log a successful step.
     * @param {string} step       - natural-language step description
     * @param {object} toolCall   - { tool, args }
     * @param {string} result     - text result from MCP
     */
    logStep(step, toolCall, result) {
        if (!ENABLED) return;
        const toolCallJSON = JSON.stringify(toolCall);
        // Only record steps that produced valid JSON tool calls
        try { JSON.parse(toolCallJSON); } catch { return; }
        this._steps.push({ step, toolCall, result });
    }

    /**
     * Called at the end of a run.
     * @param {boolean} save         - only persist if the run was meaningfully successful
     * @param {object}  [execState]  - ExecutionState used for quality gating
     */
    endRun(save, execState = null) {
        if (!ENABLED || !save || this._steps.length === 0) return;

        // Quality gate: only save runs where at least one file was modified
        // and there are no unresolved errors at the end of the run.
        if (execState) {
            const hasModified = execState.filesModified.size > 0;
            const hasError    = execState.lastError() !== null;
            if (!hasModified || hasError) {
                console.error("[collector] Skipping — quality gate: modified=", hasModified, "error=", hasError);
                return;
            }
        }

        // Dedup: compute a hash of (prompt + filesModified) to avoid duplicate examples
        const fingerprint = `${this._prompt.substring(0, 200)}|${execState ? [...execState.filesModified].sort().join(",") : ""}`;
        const existing    = fs.existsSync(DATASET_FILE)
            ? fs.readFileSync(DATASET_FILE, "utf8")
            : "";
        if (existing.includes(fingerprint)) {
            console.error("[collector] Skipping — duplicate run detected");
            return;
        }

        let saved = 0;
        for (const { step, toolCall, result } of this._steps) {
            const example = {
                messages: [
                    { role: "system",    content: SYSTEM_PROMPT },
                    {
                        role: "user",
                        content: `Project context:\n${this._prompt.substring(0, 800)}\n\nStep:\n${step}`
                    },
                    { role: "assistant", content: JSON.stringify(toolCall) }
                ],
                // Metadata for filtering/analysis — not used during training
                _meta: { fingerprint, ts: Date.now() }
            };
            try {
                fs.appendFileSync(DATASET_FILE, JSON.stringify(example) + "\n", "utf8");
                saved++;
            } catch (err) {
                console.warn("[collector] Write failed:", err.message);
            }
        }

        if (saved > 0) console.error(`[collector] Saved ${saved} training example(s)`);
    }
}

/** Legacy functional API — kept for any direct callers. */
export function recordSuccess(step, context, toolCallJSON, project) {
    if (!ENABLED) return;
    try { JSON.parse(toolCallJSON); } catch { return; }
    const example = {
        messages: [
            { role: "system",    content: SYSTEM_PROMPT },
            { role: "user",      content: `Project: ${project}\n\nContext:\n${context.substring(0, 1500)}\n\nStep:\n${step}` },
            { role: "assistant", content: toolCallJSON }
        ]
    };
    try {
        fs.appendFileSync(DATASET_FILE, JSON.stringify(example) + "\n", "utf8");
    } catch (err) {
        console.warn("[collector] Write failed:", err.message);
    }
}

export function printStats() {
    if (!fs.existsSync(DATASET_FILE)) {
        console.error("[collector] No training data collected yet.");
        return;
    }
    const lines = fs.readFileSync(DATASET_FILE, "utf8").split("\n").filter(Boolean);
    console.error(`[collector] Examples collected: ${lines.length}`);
    console.error(`[collector] Dataset: ${DATASET_FILE}`);
}
