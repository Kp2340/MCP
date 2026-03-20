import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan, updatePlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { TrainingCollector } from "../training/collector.js";
import { storeMemory } from "../vector/memory.js";
import { askLLM } from "./ollamaClient.js";
import { COMPRESS_EVERY_N_STEPS, COMPRESS_MAX_CHARS } from "../core/constants.js";

process.env.NODE_NO_WARNINGS = "1";

const MODEL        = "qwen2.5-coder:7b";
const MAX_STEPS    = 25;
const MAX_RETRIES  = 2;   // retries per step before declaring failure

const mcp       = new MCPClient();
const collector = new TrainingCollector();

console.error(`[training] ${collector.count()} examples collected so far`);

// ─── Context compression ─────────────────────────────────────────────────────
async function compressContext(context) {
    if (context.length < COMPRESS_MAX_CHARS) return context;
    console.error("[agent] Compressing context...");
    const summary = await askLLM(MODEL,
        `Summarise the following code agent execution log in 3-5 bullet points.
Focus on: what files were read, what changes were made, what errors were found.
Be concise. Output only the bullet points.

${context.substring(0, COMPRESS_MAX_CHARS)}`,
        { temperature: 0.1, num_predict: 400 }
    );
    console.error("[agent] Context compressed.");
    return `[Compressed context summary]:\n${summary}`;
}

// ─── Memory extraction ───────────────────────────────────────────────────────
async function extractAndStoreMemory(project, prompt, context) {
    try {
        // Ask LLM to extract structured insight
        const raw = await askLLM(MODEL,
            `Based on this coding agent run, output ONLY a JSON object describing one architecture pattern observed.
Fields: type ("architecture"|"fix"|"pattern"|"convention"), pattern (string, max 120 chars), files (array of relevant filenames, max 3), confidence (0.0-1.0)
Output ONLY the JSON, nothing else.

Task: ${prompt.substring(0, 200)}
Context: ${context.substring(0, 800)}`,
            { temperature: 0.1, num_predict: 120 }
        );

        let structured;
        try {
            const { extractJSON } = await import("../utils/jsonUtils.js");
            structured = JSON.parse(extractJSON(raw));
        } catch {
            structured = null;
        }

        if (structured?.pattern && structured.pattern.length > 20) {
            await storeMemory(project, structured, structured.type || "pattern");
        }
    } catch (err) {
        console.error("[agent] Memory extraction failed:", err.message);
    }
}

// ─── Step executor with retry ────────────────────────────────────────────────
async function executeWithRetry(step, context, project) {
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.error(`[agent] Retry ${attempt}/${MAX_RETRIES - 1} for step: ${step}`);
        }

        const action = await executeStep(step, context, project);

        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) {
                lastError = `Non-JSON output: ${extracted.substring(0, 100)}`;
                continue;
            }
            const parsed = JSON.parse(extracted);
            return { ok: true, parsed, raw: action };
        } catch (err) {
            lastError = err.message;
        }
    }

    return { ok: false, error: lastError };
}

// ─── Main agent loop (adaptive) ──────────────────────────────────────────────
async function runAgent(prompt) {
    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);
    if (!projectMatch) throw new Error("Prompt must include: project: <project-name>");
    const project = projectMatch[1];

    console.error("Project:", project);
    console.error("\nCreating plan...\n");

    const planContext    = await retrieveContext(prompt, project);
    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;
    const initialPlan    = await createPlan(enrichedPrompt, project);

    console.error("\nInitial Plan:\n");
    console.error(initialPlan);

    // Mutable remaining steps — adaptive replanning modifies this array
    let remainingSteps = initialPlan
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);

    let executionContext = planContext;
    let successfulSteps  = 0;
    let totalStepsDone   = 0;
    let replanCount      = 0;
    const MAX_REPLANS    = 3;

    collector.startRun(prompt);

    while (remainingSteps.length > 0 && totalStepsDone < MAX_STEPS) {

        // Compress context every N steps
        if (totalStepsDone > 0 && totalStepsDone % COMPRESS_EVERY_N_STEPS === 0) {
            executionContext = await compressContext(executionContext);
        }

        const step = remainingSteps.shift();   // take next step
        totalStepsDone++;

        console.error(`\n[${totalStepsDone}] Executing: ${step}`);

        const stepContext = await retrieveContext(step, project);
        const fullContext = executionContext + (stepContext ? "\n\n" + stepContext : "");

        const { ok, parsed, error } = await executeWithRetry(step, fullContext, project);

        // ── Step parse failed after all retries ──────────────────────────────
        if (!ok) {
            console.warn(`[agent] Step failed to parse after ${MAX_RETRIES} retries: ${error}`);

            if (replanCount < MAX_REPLANS) {
                replanCount++;
                console.error(`[agent] Replanning (attempt ${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, `Parse failure: ${error}`,
                    executionContext, project
                );
                remainingSteps = revised;
                console.error(`[agent] Revised plan has ${remainingSteps.length} remaining steps.`);
            }
            continue;
        }

        // ── Step produced a tool call ─────────────────────────────────────────
        if (parsed.tool) {
            console.error(`\n  → Calling tool: ${parsed.tool}`);
            console.error(`    Args: ${JSON.stringify(parsed.args).substring(0, 200)}`);

            let resultText = "";
            let toolFailed = false;

            try {
                const result = await mcp.callTool(parsed.tool, parsed.args || {});
                resultText = result?.content
                    ?.map(c => c.text || "").join("\n")
                    .substring(0, 3000) || "";

                console.error(`\n  ← Result (${resultText.length} chars)`);
                if (resultText.length < 500) console.error(resultText);

                // Detect tool-level failure signals in result text
                const lowerResult = resultText.toLowerCase();
                if (
                    lowerResult.includes("error:") ||
                    lowerResult.includes("build failed") ||
                    lowerResult.includes("exception") ||
                    lowerResult.includes("not found")
                ) {
                    toolFailed = true;
                }

            } catch (toolErr) {
                console.warn(`[agent] Tool error: ${toolErr.message}`);
                resultText = `Tool error: ${toolErr.message}`;
                toolFailed = true;
            }

            executionContext += `\n\n[Step ${totalStepsDone} — ${parsed.tool}]:\n${resultText}`;

            if (toolFailed && replanCount < MAX_REPLANS) {
                // ── Adaptive replan on tool failure ──────────────────────────
                replanCount++;
                console.error(`[agent] Tool failure detected. Replanning (${replanCount}/${MAX_REPLANS})...`);
                const revised = await updatePlan(
                    remainingSteps, step, resultText,
                    executionContext, project
                );
                remainingSteps = revised;
                console.error(`[agent] Revised plan has ${remainingSteps.length} remaining steps.`);
            }

            collector.logStep(step, { tool: parsed.tool, args: parsed.args }, resultText);
            successfulSteps++;
        }

        if (parsed.done) {
            console.error("\nTask completed\n");
            break;
        }
    }

    collector.endRun(successfulSteps >= 2);

    if (successfulSteps >= 2) {
        await extractAndStoreMemory(project, prompt, executionContext);
    }

    console.error(`\nAgent finished — ${successfulSteps} successful steps, ${replanCount} replans\n`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Prompt: ", async (prompt) => {
    try {
        await runAgent(prompt);
    } catch (err) {
        console.error("Agent error:", err.message);
    }
    process.exit();
});
