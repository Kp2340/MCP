import { askLLM } from "./ollamaClient.js";
import { listProjects } from "../core/projectRegistry.js";

const MODEL = "qwen2.5-coder:7b";

export async function createPlan(prompt) {
  const planPrompt = `You are an AI coding agent.

Available MCP tools:
project_scan
project_search
project_find_symbol
project_read_files
project_apply_search_replace
project_apply_changes
project_build_and_fix

Rules:
- Max 6 steps
- One tool per step
- Always scan project if file paths unknown
- Always read files before editing
- Use project_apply_changes to create new files.
- Use search_replace only when editing existing files.
- Run build only once at end

Task:
${prompt}

Return a numbered step plan.`;

  return await askLLM(MODEL, planPrompt, {
    temperature: 0.2,
    num_predict: 800,
  });
}
