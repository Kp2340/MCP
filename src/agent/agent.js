import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { TrainingCollector } from "../training/collector.js";

process.env.NODE_NO_WARNINGS = "1";

const mcp = new MCPClient();
const collector = new TrainingCollector();

console.error(`[training] ${collector.count()} examples collected so far`);

async function runAgent(prompt) {
    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);
    if (!projectMatch) {
        throw new Error("Prompt must include: project: <project-name>");
    }
    const project = projectMatch[1];

    console.error("Project:", project);
    console.error("\nCreating plan...\n");

    // Retrieve context ONCE for the full plan — not again per step
    const planContext = await retrieveContext(prompt, project);

    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;
    const plan = await createPlan(enrichedPrompt);

    console.error("\nPlan:\n");
    console.error(plan);

    // Parse numbered steps robustly — handles "1." "1)" "Step 1:" etc.
    const steps = plan
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);

    let executionContext = planContext;  // Seed context with plan context
    const MAX_STEPS = 20;
    let successfulSteps = 0;

    collector.startRun(prompt);

    for (let i = 0; i < steps.length && i < MAX_STEPS; i++) {
        const step = steps[i];
        if (!step) continue;

        console.error(`\n[${i + 1}/${steps.length}] Executing: ${step}`);

        // Retrieve fresh vector context for each step (delta context)
        const stepContext = await retrieveContext(step, project);
        const fullContext = executionContext + (stepContext ? "\n\n" + stepContext : "");

        const action = await executeStep(step, fullContext, project);

        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) {
                console.error(extracted);
                continue;
            }

            const parsed = JSON.parse(extracted);

            if (parsed.tool) {
                console.error(`\n  → Calling tool: ${parsed.tool}`);
                console.error(`    Args: ${JSON.stringify(parsed.args)}`);

                const result = await mcp.callTool(parsed.tool, parsed.args || {});

                // Extract text content from MCP result for context
                const resultText = result?.content
                    ?.map(c => c.text || "")
                    .join("\n")
                    .substring(0, 3000) || "";

                console.error(`\n  ← Result (${resultText.length} chars)`);
                if (resultText.length < 500) console.error(resultText);

                executionContext += `\n\n[Step ${i + 1} result]:\n${resultText}`;

                // Log successful tool call for training data collection
                collector.logStep(step, { tool: parsed.tool, args: parsed.args }, resultText);
                successfulSteps++;
            }

            if (parsed.done) {
                console.error("\nTask completed\n");
                break;
            }

        } catch (err) {
            console.warn(`\n[agent] Step ${i + 1} error: ${err.message}`);
            console.warn("Raw output:", action);
        }
    }

    // Save training data only if the run had meaningful successful steps
    collector.endRun(successfulSteps >= 2);

    console.error("\nAgent finished\n");
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question("Prompt: ", async (prompt) => {
    try {
        await runAgent(prompt);
    } catch (err) {
        console.error("Agent error:", err.message);
    }
    process.exit();
});