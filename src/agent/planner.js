import { askLLM } from "./ollamaClient.js";
import { listProjects, getProject } from "../core/projectRegistry.js";
import { queryMemory } from "../vector/memory.js";
import {
    TOOL_CHAIN_TEMPLATES,
    MAX_LLM_CALLS_PER_RUN,
    CHARS_PER_TOKEN,
    LLM_MODEL,
    NUM_PREDICT,
    KEYWORD_STEMS
} from "../core/constants.js";
import { formatStateForPrompt } from "./executionState.js";
import { generateDirectFix, extractErrorFilePath } from "./errorFixer.js";

const MODEL = LLM_MODEL;

// ─── Deterministic failure recovery tools ────────────────────────────────────────────────
export const DETERMINISTIC_RECOVERY_TOOLS = {
    import_error: (project, execState) => {
        const errText   = execState.lastError()?.text || "";
        const modName   = errText.match(/['"](\S+)['"]|module '([^']+)'/)?.[1] ||
                          errText.match(/unresolved.*?:\s*(\S+)/i)?.[1] || "import";
        const filePath  = extractErrorFilePath(execState);
        const directFix = generateDirectFix(project, execState);
        const steps     = [{ tool: "project_search", args: { project, query: modName } }];
        if (filePath && !execState.hasRead(filePath))
            steps.push({ tool: "project_read_files", args: { project, paths: [filePath] } });
        if (directFix) steps.push(directFix);
        steps.push({ tool: "project_analyze",      args: { project } });
        steps.push({ tool: "project_build_and_fix", args: { project } });
        return steps;
    },
    syntax_error: (project, execState) => {
        const filePath = extractErrorFilePath(execState);
        const steps    = [{ tool: "project_analyze", args: { project } }];
        if (filePath && !execState.hasRead(filePath))
            steps.push({ tool: "project_read_files", args: { project, paths: [filePath] } });
        steps.push({ tool: "project_build_and_fix", args: { project } });
        return steps;
    },
    build_failure: (project, execState) => {
        const filePath = extractErrorFilePath(execState);
        const steps    = [{ tool: "project_analyze", args: { project } }];
        if (filePath && !execState.hasRead(filePath))
            steps.push({ tool: "project_read_files", args: { project, paths: [filePath] } });
        steps.push({ tool: "project_build_and_fix", args: { project } });
        return steps;
    },
    not_found: (project, execState) => [
        { tool: "project_search",  args: { project, query: execState.lastError()?.text?.substring(0, 60) || "" } },
        { tool: "project_analyze", args: { project } }
    ],
    runtime_error: (project, execState) => {
        const filePath  = extractErrorFilePath(execState);
        const directFix = generateDirectFix(project, execState);
        const steps     = [{ tool: "project_analyze", args: { project } }];
        if (filePath && !execState.hasRead(filePath))
            steps.push({ tool: "project_read_files", args: { project, paths: [filePath] } });
        if (directFix) steps.push(directFix);
        steps.push({ tool: "project_build_and_fix", args: { project } });
        return steps;
    },
    permission_error: (project, _execState) => [
        { tool: "project_scan", args: { project } }
    ]
};

export function handleFailureDeterministically(failureType, project, execState) {
    const factory = DETERMINISTIC_RECOVERY_TOOLS[failureType];
    if (!factory) return null;
    const toolSteps = factory(project, execState);
    console.error(`[planner] ⚡ Tool-level recovery for "${failureType}" — ${toolSteps.length} direct tool calls (0 LLM)`);
    return toolSteps;
}

// ─── Token estimator ────────────────────────────────────────────────────────────────────
export function estimateTokens(...texts) {
    const totalChars = texts.reduce((sum, t) => sum + (t ? t.length : 0), 0);
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── Shared context builder ───────────────────────────────────────────────────────────────
async function buildPlannerContext(project, intent = null) {
    const projects = listProjects().join(", ");
    let memoryContext = "";
    if (project) {
        const filterType = intent === "ui"  ? "architecture" :
                           intent === "api" ? "architecture" :
                           intent === "fix" ? "fix"          : null;
        const memory = await queryMemory(project, "", { returnStructured: true, filterType });
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
- project_read_files    — read file contents (re-read after modifying!)
- project_str_replace   — targeted search-and-replace (PREFER for edits)
- project_apply_changes — write full file and commit (new files only)
- project_build_and_fix — build and auto-fix errors
- project_analyze       — static analysis before build
- project_test          — run test suite

Rules:
- Always read relevant files before modifying them
- Re-read a file after modifying it before the next str_replace on it
- Use project_find_symbol to locate components before reading them
- Prefer project_str_replace over project_apply_changes for small edits
- ALWAYS run project_analyze before project_build_and_fix
- After applying code changes ALWAYS run project_build_and_fix
- Return ONLY numbered steps, one per line, no explanation`;

// ─── Heuristic planner ───────────────────────────────────────────────────────────────────
function tryHeuristicPlan(prompt, projectType = null, retrieverIntent = null, activeErrorType = null) {
    let lower = prompt.toLowerCase();
    for (const [stem, canonical] of Object.entries(KEYWORD_STEMS)) {
        lower = lower.replace(new RegExp(`\\b${stem}\\b`, "g"), canonical);
    }
    let bestTemplate = null;
    let bestScore    = 0;

    const ERROR_INTENT_MAP = {
        import_error: "fix", syntax_error: "fix", build_failure: "fix",
        runtime_error: "fix", not_found: "fix", permission_error: "fix"
    };
    const errorImpliedIntent = activeErrorType ? ERROR_INTENT_MAP[activeErrorType] : null;

    for (const template of TOOL_CHAIN_TEMPLATES) {
        if (template.projectTypes && projectType && !template.projectTypes.includes(projectType)) continue;
        const keywordHits = template.keywords.filter(kw => lower.includes(kw)).length;
        if (keywordHits === 0) continue;
        const intentBonus = (retrieverIntent && retrieverIntent === template.intent) ? 1 : 0;
        const errorBias   = (errorImpliedIntent && template.intent === errorImpliedIntent) ? 2 : 0;
        const score       = keywordHits + intentBonus + errorBias;
        if (score > bestScore) { bestScore = score; bestTemplate = template; }
    }

    if (bestScore >= 2 && bestTemplate) {
        const biasLabel = activeErrorType ? `, errBias=${activeErrorType}` : "";
        console.error(`[planner] Heuristic: "${bestTemplate.name}" (score=${bestScore}, type=${projectType || "any"}, intent=${retrieverIntent || "none"}${biasLabel}) — skipping LLM`);
        return bestTemplate.steps;
    }
    return null;
}

function getProjectType(project) {
    try { return getProject(project)?.type || null; } catch { return null; }
}

// ─── createPlan ───────────────────────────────────────────────────────────────────────
export async function createPlan(prompt, project = null, costState = null, retrieverIntent = null, execState = null) {
    const projectType     = getProjectType(project);
    const activeError     = execState?.lastError();
    const activeErrorType = activeError?.type || null;

    // Hard override: active error → deterministic plan (0 LLM)
    if (activeError && activeErrorType && DETERMINISTIC_RECOVERY_TOOLS[activeErrorType]) {
        console.error(`[planner] ⚡ HARD OVERRIDE: active ${activeErrorType} — forcing deterministic plan (no LLM)`);
        const toolSteps = DETERMINISTIC_RECOVERY_TOOLS[activeErrorType](project || "unknown", execState);
        return toolSteps.map((s, i) => `${i + 1}. ${s.tool}`).join("\n");
    }

    // Heuristic (0 LLM)
    const heuristicSteps = tryHeuristicPlan(prompt, projectType, retrieverIntent, activeErrorType);
    if (heuristicSteps) return heuristicSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");

    // Cost guard
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[planner] LLM call budget exhausted — using minimal fallback plan");
        return "1. Run static analysis\n2. Run build and fix";
    }

    // LLM plan
    const { projects, memoryContext } = await buildPlannerContext(project, retrieverIntent);
    if (costState) costState.llmCalls++;

    const stateBlock = execState ? formatStateForPrompt(execState) : "";

    const planPrompt = `You are a deterministic software planning agent.
Your goal: produce the MINIMUM steps needed to complete the task correctly.

Available projects: ${projects}
Current project: ${project || "unknown"}

${memoryContext}
${stateBlock ? `Execution state so far:\n${stateBlock}\n` : ""}

${TOOL_REFERENCE}

Task: ${prompt}

Output ONLY numbered steps, one per line, no explanation:`;

    try {
        const raw = await askLLM(MODEL, planPrompt, { temperature: 0.1, num_predict: NUM_PREDICT.planner });
        return raw.trim() || "1. Run static analysis\n2. Run build and fix";
    } catch (err) {
        console.error("[planner] createPlan LLM error:", err.message);
        return "1. Run static analysis\n2. Run build and fix";
    }
}

// ─── updatePlan ───────────────────────────────────────────────────────────────────────
export async function updatePlan(
    originalPrompt, remainingSteps, executionContext,
    errorType, project, costState, retrieverIntent, execState
) {
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) return null;

    const { memoryContext } = await buildPlannerContext(project, retrieverIntent);
    if (costState) costState.llmCalls++;

    const stateBlock = formatStateForPrompt(execState);

    const replanPrompt = `You are a deterministic software planning agent doing a MID-RUN REPLAN.
The original task hit an error. Generate ONLY the minimal additional steps to recover and complete.

Original task: ${originalPrompt.substring(0, 300)}

Execution state:
${stateBlock}

Error type: ${errorType}

Remaining steps (now possibly invalid):
${remainingSteps.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join("\n") || "none"}

Recent context:
${executionContext.substring(executionContext.length - 1500)}

${TOOL_REFERENCE}

Output ONLY numbered steps to recover and complete. Maximum 5 steps. No explanation.`;

    try {
        const raw   = await askLLM(MODEL, replanPrompt, { temperature: 0.1, num_predict: 300 });
        const lines = raw.split("\n")
            .map(s => s.replace(/^(\d+[\.\):]|\bstep\s*\d+[:\.]?)\s*/i, "").trim())
            .filter(s => s.length > 4);
        return lines.length > 0 ? lines.join("\n") : null;
    } catch (err) {
        console.error("[planner] updatePlan error:", err.message);
        return null;
    }
}
