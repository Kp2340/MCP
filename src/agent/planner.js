import { askLLM } from "./ollamaClient.js";

const MODEL = "qwen2.5-coder:7b";

export async function createPlan(prompt) {

    const planPrompt = `
You are a senior software planning agent.

Available MCP tools:

project_scan
project_search
project_find_symbol
project_read_files
project_apply_changes
project_build_and_fix

Rules:
- Always read relevant files before modifying them
- After applying code changes ALWAYS run project_build_and_fix
- Return only numbered steps
- No explanations

Task:
${prompt}
`;

    return await askLLM(MODEL, planPrompt);
}