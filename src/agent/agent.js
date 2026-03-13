import readline from "readline";
import { MCPClient } from "./mcpClient.js";
import { createPlan } from "./planner.js";
import { executeStep } from "./executor.js";
import { retrieveContext } from "./retriever.js";

process.env.NODE_NO_WARNINGS = "1";

const mcp = new MCPClient();

function cleanJSON(text) {
    if (!text) return "";

    return text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
}

async function runAgent(prompt) {

    const projectMatch = prompt.match(/project:\s*([a-zA-Z0-9-_]+)/i);

    if (!projectMatch) {
        throw new Error("Prompt must contain: project: <project-name>");
    }

    const project = projectMatch[1];

    console.log("Project:", project);

    console.log("\nCreating plan...\n");

    const context = await retrieveContext(prompt, project);

    const enrichedPrompt = `
User request:
${prompt}

Context:
${context}
`;

    const plan = await createPlan(enrichedPrompt);

    console.log("\nPlan:\n");
    console.log(plan);

    const steps = plan
        .split("\n")
        .map(s => s.replace(/^\d+\.\s*/, "").trim())
        .filter(Boolean);

    let executionContext = "";

    const MAX_STEPS = 20;

    for (let i = 0; i < steps.length && i < MAX_STEPS; i++) {

        const step = steps[i].trim();

        if (!step) continue;

        console.log("\nExecuting:", step);

        const vectorContext = await retrieveContext(step, project);

        const action = await executeStep(
            step,
            executionContext + "\n" + vectorContext,
            project
        );

        try {

            const cleaned = cleanJSON(action);

            if (!cleaned.startsWith("{")) {
                console.log(cleaned);
                continue;
            }

            const parsed = JSON.parse(cleaned);

            if (parsed.tool) {

                console.log("\nCalling tool:", parsed.tool);

                const result = await mcp.callTool(
                    parsed.tool,
                    parsed.args || {}
                );

                console.log("\nTool result:\n", result);

                executionContext += "\n" + JSON.stringify(result);

            }

            if (parsed.done) {
                console.log("\nTask completed\n");
                break;
            }

        } catch (err) {

            console.log("\nInvalid JSON from model:");
            console.log(action);

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
        console.error("Agent error:", err);
    }

    process.exit();

});