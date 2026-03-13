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
- ALWAYS start with project_scan if the file path is not known
- ALWAYS read AuthContext, router, and the target file before writing any code
- NEVER call project_apply_changes without first reading the file you are modifying
- NEVER include project_apply_changes twice in a plan for the same file
- Create new pages as NEW files — do not replace existing components
- After applying changes, run project_build_and_fix ONCE at the end
- Maximum 6 steps
- Each step must correspond to exactly one tool call
Task:
${prompt}
`;

  return await askLLM(MODEL, planPrompt, {
    temperature: 0.2,
    num_predict: 800,
  });
}
