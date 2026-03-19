import { askLLM } from "./ollamaClient.js";
import { listProjects } from "../core/projectRegistry.js";

const MODEL = "qwen2.5-coder:7b";

export async function createPlan(prompt) {
    const projects = listProjects().join(", ");

    const planPrompt = `You are a senior software planning agent.

Available projects: ${projects}

Available MCP tools:
- project_scan        — list files/folders
- project_search      — ripgrep text search
- project_find_symbol — find class or function by name
- project_read_files  — read file contents
- project_apply_changes — write files and commit
- project_build_and_fix — build and auto-fix errors

Rules:
- Always read relevant files before modifying them
- Use project_find_symbol to locate components before reading them
- After applying code changes ALWAYS run project_build_and_fix
- Return ONLY numbered steps, one per line, no explanation

Task:
${prompt}
`;

    return await askLLM(MODEL, planPrompt, { temperature: 0.2, num_predict: 800 });
}