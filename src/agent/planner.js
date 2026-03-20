import { askLLM } from "./ollamaClient.js";
import { listProjects, getProject } from "../core/projectRegistry.js";
import { queryMemory } from "../vector/memory.js";
import {
    TOOL_CHAIN_TEMPLATES,
    MAX_LLM_CALLS_PER_RUN,
    CHARS_PER_TOKEN
} from "../core/constants.js";
import { formatStateForPrompt } from "./executionState.js";

const MODEL = "qwen2.5-coder:7b";

// ─── Real token estimator ────────────────────────────────────────────────────
export function estimateTokens(...texts) {
    const totalChars = texts.reduce((sum, t) => sum + (t ? t.length : 0), 0);
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── Shared context builder ─────────────────────────────────────────────────
async function buildPlannerContext(project, intent = null) {
    const projects = listProjects().join(", ");
    let memoryContext = "";

    if (project) {
        // Filter memory by intent type when we know it — avoids injecting
        // backend patterns into a frontend step and vice versa.
        const filterType = intent === "ui"  ? "architecture" :
                           intent === "api" ? "architecture" :
                           intent === "fix" ? "fix"          : null;

        const memory = await queryMemory(project, "", {
            returnStructured: true,
            filterType
        });

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

// ─── Context-aware heuristic planner ──────────────────────────────────────────
/**
 * Tries to match a prompt against tool-chain templates using:
 *   1. keyword hits (as before)
 *   2. project type filter (spring-boot won't use add_ui_component)
 *   3. intent hint from retriever (ui/api/fix/general)
 *
 * Returns template steps if confident match found, or null.
 */
function tryHeuristicPlan(prompt, projectType = null, retrieverIntent = null) {
    const lower = prompt.toLowerCase();
    let bestTemplate = null;
    let bestScore    = 0;

    for (const template of TOOL_CHAIN_TEMPLATES) {
        // Skip templates scoped to other project types
        if (template.projectTypes && projectType &&
            !template.projectTypes.includes(projectType)) {
            continue;
        }

        const keywordHits = template.keywords.filter(kw => lower.includes(kw)).length;
        if (keywordHits === 0) continue;

        // Intent bonus: +1 if retriever intent matches template intent
        const intentBonus = (retrieverIntent && retrieverIntent === template.intent) ? 1 : 0;

        const score = keywordHits + intentBonus;

        if (score > bestScore) {
            bestScore    = score;
            bestTemplate = template;
        }
    }

    // Require ≥2 total score to avoid false positives
    if (bestScore >= 2 && bestTemplate) {
        console.error(
            `[planner] Heuristic: "${bestTemplate.name}" ` +
            `(score=${bestScore}, type=${projectType || "any"}, intent=${retrieverIntent || "none"}) — skipping LLM`
        );
        return bestTemplate.steps;
    }

    return null;
}

// ─── Project type lookup ─────────────────────────────────────────────────────────
function getProjectType(project) {
    try {
        return getProject(project)?.type || null;
    } catch {
        return null;
    }
}

/**
 * Initial plan creation.
 *
 * @param {string}  prompt
 * @param {string}  [project]
 * @param {object}  [costState]        — { llmCalls } mutated in place
 * @param {string}  [retrieverIntent]  — intent label from retriever
 * @returns {string}  newline-separated numbered steps
 */
export async function createPlan(prompt, project = null, costState = null, retrieverIntent = null) {
    const projectType = getProjectType(project);

    // 1. Context-aware heuristic (zero LLM cost)
    const heuristicSteps = tryHeuristicPlan(prompt, projectType, retrieverIntent);
    if (heuristicSteps) {
        return heuristicSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    }

    // 2. Cost guard
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[planner] LLM call budget exhausted — using minimal fallback plan");
        return "1. Run static analysis\n2. Run build and fix";
    }

    // 3. LLM plan — memory filtered by intent
    const { projects, memoryContext } = await buildPlannerContext(project, retrieverIntent);
    if (costState) costState.llmCalls++;

    const planPrompt = `You are a senior software planning agent.

Available projects: ${projects}
Project type: ${projectType || "unknown"}
${memoryContext}
${TOOL_REFERENCE}

Task:
${prompt}
`;

    return await askLLM(MODEL, planPrompt, { temperature: 0.2, num_predict: 800 });
}

/**
 * Adaptive replanning.
 * Now includes execution state for much better recovery reasoning.
 *
 * @param {string[]}       remainingSteps
 * @param {string}         failedStep
 * @param {string}         failureReason
 * @param {string}         context
 * @param {string}         [project]
 * @param {object}         [costState]
 * @param {ExecutionState} [execState]
 * @returns {string[]}
 */
export async function updatePlan(
    remainingSteps, failedStep, failureReason, context,
    project = null, costState = null, execState = null
) {
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[planner] LLM budget exhausted during replan — safe fallback");
        return ["Run static analysis", "Run build and fix to verify"];
    }

    const projectType = getProjectType(project);

    // Extract failure type from execState for targeted recovery
    const lastError   = execState?.lastError();
    const failureType = lastError?.type || "unknown";

    const { projects, memoryContext } = await buildPlannerContext(project);
    if (costState) costState.llmCalls++;

    // Format execution state for prompt injection
    const stateBlock = execState
        ? `\nExecution state:\n${formatStateForPrompt(execState)}\n`
        : "";

    const replanPrompt = `You are a senior software planning agent doing mid-run correction.

Available projects: ${projects}
Project type: ${projectType || "unknown"}
${memoryContext}
${TOOL_REFERENCE}
${stateBlock}
Execution context so far:
${context.substring(0, 1200)}

Failed step: ${failedStep}
Failure type: ${failureType}
Failure reason: ${failureReason.substring(0, 500)}

Remaining steps that were planned:
${remainingSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Revise the remaining plan to recover from this ${failureType} failure.
Return ONLY numbered steps, one per line, no explanation.
Do NOT repeat already-completed steps.
`;

    const revised = await askLLM(MODEL, replanPrompt, { temperature: 0.2, num_predict: 600 });

    return revised
        .split("\n")
        .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
        .filter(s => s.length > 4);
}
