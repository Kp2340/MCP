import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { recordSuccess, printStats } from "../training/collector.js";

process.env.NODE_NO_WARNINGS = "1";

const mcp = new MCPClient();

printStats();

async function runAgent(prompt) {
    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);
    if (!projectMatch) {
        throw new Error("Prompt must include: project: <project-name>");
    }
    const project = projectMatch[1];

    console.log("Project:", project);
    console.log("\nCreating plan...\n");

    const planContext = await retrieveContext(prompt, project);
    const enrichedPrompt = `User request:\n${prompt}\n\nRelevant code context:\n${planContext}`;
    const plan = await createPlan(enrichedPrompt);

    console.log("\nPlan:\n");
    console.log(plan);

    const steps = plan
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);

    let executionContext = planContext;
    const MAX_STEPS = 7;

    for (let i = 0; i < steps.length && i < MAX_STEPS; i++) {
        const step = steps[i];
        if (!step) continue;

        console.log(`\n[${i + 1}/${steps.length}] Executing: ${step}`);

        const stepContext = await retrieveContext(step, project);
        const fullContext = executionContext + (stepContext ? "\n\n" + stepContext : "");

        const action = await executeStep(step, fullContext, project);

        try {
            const extracted = extractJSON(action);
            if (!extracted.startsWith("{")) {
                console.log(extracted);
                continue;
            }

            const parsed = JSON.parse(extracted);

            if (parsed.tool) {
                console.log(`\n  -> Calling tool: ${parsed.tool}`);
                console.log(`    Args: ${JSON.stringify(parsed.args)}`);

                const result = await mcp.callTool(parsed.tool, parsed.args || {});

                const resultText = result?.content
                    ?.map(c => c.text || "")
                    .join("\n")
                    .substring(0, 3000) || "";

                console.log(`\n  <- Result (${resultText.length} chars)`);
                if (resultText.length < 500) console.log(resultText);

                executionContext += `\n\n[Step ${i + 1} result]:\n${resultText}`;

                // Record for training data collection (no-op unless COLLECT_TRAINING_DATA=1)
                recordSuccess(step, fullContext, JSON.stringify({ tool: parsed.tool, args: parsed.args }), project);
            }

            if (parsed.done) {
                console.log("\nTask completed\n");
                break;
            }

        } catch (err) {
            console.warn(`\n[agent] Step ${i + 1} error: ${err.message}`);
            console.warn("Raw output:", action);
        }
    }

    console.log("\nAgent finished\n");
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
