import { askLLM } from "./ollamaClient.js";
import { listProjects } from "../core/projectRegistry.js";
import { queryMemory } from "../vector/memory.js";

const MODEL = "qwen2.5-coder:7b";

// ─── Shared prompt builder ───────────────────────────────────────────────────
async function buildPlannerContext(project) {
    const projects = listProjects().join(", ");
    let memoryContext = "";
    if (project) {
        const memory = await queryMemory(project, "", { returnStructured: true });
        if (memory && memory.length > 0) {
            const lines = memory
                .map(m => `  [${m.type || "pattern"}] ${m.pattern || m.text}` +
                    (m.files?.length ? ` (files: ${m.files.slice(0, 3).join(", ")})` : ""))
                .join("\n");
            memoryContext = `\nKnown architecture patterns for this project:\n${lines}\n`;
        }
    }
    return { projects, memoryContext };
}

const TOOL_REFERENCE = `Available MCP tools:
- project_scan          — list files/folders
- project_search        — ripgrep text search
- project_find_symbol   — find class or function by name
- project_read_files    — read file contents
- project_str_replace   — targeted search-and-replace edit (PREFER for small changes)
- project_apply_changes — write full file and commit (use only for new files)
- project_build_and_fix — build and auto-fix errors
- project_analyze       — static analysis before build

Rules:
- Always read relevant files before modifying them
- Use project_find_symbol to locate components before reading them
- Prefer project_str_replace over project_apply_changes for small edits
- Run project_analyze before project_build_and_fix to catch issues early
- After applying code changes ALWAYS run project_build_and_fix
- Return ONLY numbered steps, one per line, no explanation`;

/**
 * Initial plan creation — called once at the start of a run.
 */
export async function createPlan(prompt, project = null) {
    const { projects, memoryContext } = await buildPlannerContext(project);

    const planPrompt = `You are a senior software planning agent.

Available projects: ${projects}
${memoryContext}
${TOOL_REFERENCE}

Task:
${prompt}
`;

    return await askLLM(MODEL, planPrompt, { temperature: 0.2, num_predict: 800 });
}

/**
 * Adaptive replanning — called mid-run when a step fails or produces an
 * unexpected result. Returns a new list of remaining steps.
 *
 * @param {string[]} remainingSteps - steps not yet executed
 * @param {string}   failedStep     - the step that failed or needs revision
 * @param {string}   failureReason  - error message or unexpected result text
 * @param {string}   context        - current execution context summary
 * @param {string}   project
 * @returns {string[]} revised remaining steps
 */
export async function updatePlan(remainingSteps, failedStep, failureReason, context, project = null) {
    const { projects, memoryContext } = await buildPlannerContext(project);

    const replanPrompt = `You are a senior software planning agent doing mid-run correction.

Available projects: ${projects}
${memoryContext}
${TOOL_REFERENCE}

Execution context so far:
${context.substring(0, 1500)}

Failed step:
${failedStep}

Failure reason:
${failureReason.substring(0, 600)}

Remaining steps that were planned:
${remainingSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Revise the remaining plan to recover from the failure.
Return ONLY numbered steps, one per line, no explanation.
Do NOT repeat already-completed steps.
`;

    const revised = await askLLM(MODEL, replanPrompt, { temperature: 0.2, num_predict: 600 });

    return revised
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);
}
