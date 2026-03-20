import { askLLM } from "./ollamaClient.js";
import { listProjects } from "../core/projectRegistry.js";
import { queryMemory } from "../vector/memory.js";
import {
    TOOL_CHAIN_TEMPLATES,
    MAX_LLM_CALLS_PER_RUN
} from "../core/constants.js";

const MODEL = "qwen2.5-coder:7b";

// ─── Shared context builder ─────────────────────────────────────────────────
async function buildPlannerContext(project) {
    const projects = listProjects().join(", ");
    let memoryContext = "";
    if (project) {
        const memory = await queryMemory(project, "", { returnStructured: true });
        if (memory && memory.length > 0) {
            const lines = memory
                .map(m =>
                    `  [${m.type || "pattern"}] ${m.pattern || m.text}` +
                    (m.files?.length ? ` (files: ${m.files.slice(0, 3).join(", ")})` : "")
                )
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
- ALWAYS run project_analyze before project_build_and_fix
- After applying code changes ALWAYS run project_build_and_fix
- Return ONLY numbered steps, one per line, no explanation`;

// ─── Heuristic planner ─────────────────────────────────────────────────────
// Matches a prompt against known task templates.
// Returns template steps if matched (zero LLM cost), or null if LLM is needed.
function tryHeuristicPlan(prompt) {
    const lower = prompt.toLowerCase();
    let bestTemplate = null;
    let bestHits     = 0;

    for (const template of TOOL_CHAIN_TEMPLATES) {
        const hits = template.keywords.filter(kw => lower.includes(kw)).length;
        if (hits > bestHits) {
            bestHits     = hits;
            bestTemplate = template;
        }
    }

    // Only trust the heuristic if at least 2 keywords matched
    if (bestHits >= 2 && bestTemplate) {
        console.error(`[planner] Heuristic matched template: "${bestTemplate.name}" (${bestHits} keywords) — skipping LLM`);
        return bestTemplate.steps;
    }

    return null;  // not confident enough — fall through to LLM
}

/**
 * Initial plan creation.
 * Tries heuristic templates first; falls back to LLM only if needed.
 *
 * @param {string}  prompt
 * @param {string}  [project]
 * @param {object}  [costState]  — { llmCalls: number } mutated in place
 * @returns {string}  newline-separated numbered steps
 */
export async function createPlan(prompt, project = null, costState = null) {
    // 1. Try zero-cost heuristic first
    const heuristicSteps = tryHeuristicPlan(prompt);
    if (heuristicSteps) {
        return heuristicSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    }

    // 2. Cost guard
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[planner] LLM call budget exhausted — using minimal fallback plan");
        return "1. Run static analysis\n2. Run build and fix";
    }

    // 3. LLM plan
    const { projects, memoryContext } = await buildPlannerContext(project);
    if (costState) costState.llmCalls++;

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
 * Adaptive replanning — called mid-run when a step fails.
 * Respects LLM call budget; returns minimal recovery plan if budget exceeded.
 *
 * @param {string[]} remainingSteps
 * @param {string}   failedStep
 * @param {string}   failureReason
 * @param {string}   context
 * @param {string}   [project]
 * @param {object}   [costState]
 * @returns {string[]}  revised remaining steps
 */
export async function updatePlan(
    remainingSteps, failedStep, failureReason, context,
    project = null, costState = null
) {
    // Cost guard — return safe minimal recovery instead of another LLM call
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[planner] LLM budget exhausted during replan — using safe fallback");
        return ["Run static analysis", "Run build and fix to verify"];
    }

    const { projects, memoryContext } = await buildPlannerContext(project);
    if (costState) costState.llmCalls++;

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
