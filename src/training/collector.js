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
    console.log("[collector] Training data collection ENABLED");
    console.log("[collector] Writing to:", DATASET_FILE);
}

/**
 * Record a successful agent step as a training example.
 * Only records steps where the model produced valid JSON.
 */
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
        console.log("[collector] No training data collected yet.");
        return;
    }
    const lines = fs.readFileSync(DATASET_FILE, "utf8").split("\n").filter(Boolean);
    console.log(`[collector] Examples collected: ${lines.length}`);
    console.log(`[collector] Dataset: ${DATASET_FILE}`);
}
