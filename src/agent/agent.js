import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";
import { extractJSON } from "../utils/jsonUtils.js";

const mcp = new MCPClient();

const MAX_STEPS = 6;

async function runAgent(prompt) {

    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);

    if (!projectMatch) {
        throw new Error("Prompt must include: project: <project-name>");
    }

    const project = projectMatch[1];

    console.log("Project:", project);

    const planContext = await retrieveContext(prompt, project);

    const enrichedPrompt =
        `User request:\n${prompt}\n\nRelevant code:\n${planContext}`;

    const plan = await createPlan(enrichedPrompt);

    console.log("\nPlan:\n");
    console.log(plan);

    const steps = plan
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);

    let executionContext = planContext;

    for (let i = 0; i < steps.length && i < MAX_STEPS; i++) {

        const step = steps[i];

        console.log(`\n[${i + 1}/${steps.length}] Executing: ${step}`);

        const stepContext = await retrieveContext(step, project);

        const fullContext = executionContext + "\n\n" + stepContext;

        const action = await executeStep(step, fullContext, project);

        try {

            const extracted = extractJSON(action);

            const parsed = JSON.parse(extracted);

            if (parsed.tool) {

                console.log(`Calling tool: ${parsed.tool}`);

                const result = await mcp.callTool(parsed.tool, parsed.args || {});

                const resultText = result?.content
                    ?.map(c => c.text || "")
                    .join("\n")
                    .substring(0, 3000) || "";

                console.log(resultText);

                executionContext += `\n\n${resultText}`;
            }

        } catch (err) {

            console.warn("Step error:", err.message);
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