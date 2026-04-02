import { askLLM } from "./ollamaClient.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { MAX_LLM_CALLS_PER_RUN, LLM_MODEL, NUM_PREDICT } from "../core/constants.js";
import { buildExecutorPrompt } from "../prompts/executor.js";

const MODEL = LLM_MODEL;

// ─── Rule-based tool router ──────────────────────────────────────────────────────────────────
// Fires BEFORE the LLM. If a step matches a confident rule the LLM call is
// skipped entirely — zero tokens, zero latency.
function routeByRule(step, project) {
    const s = step.toLowerCase();

    if (/\b(scan|list files|folder structure|project structure)\b/.test(s))
        return JSON.stringify({ tool: "project_scan", args: { project } });

    if (/\b(find|locate|look up)\b.*(symbol|class|function|component|service|controller)/i.test(s)) {
        const pascalWords  = step.match(/\b[A-Z][a-z][\w]{1,}\b/g) || [];
        const genericWords = new Set(["Find", "Read", "Run", "Apply", "Create", "Check", "Build", "Use",
            "The", "This", "That", "With", "From", "Into", "After", "Before"]);
        const symbolName = pascalWords.filter(w => !genericWords.has(w)).pop();
        if (symbolName) return JSON.stringify({ tool: "project_find_symbol", args: { project, name: symbolName } });
        return null;
    }

    const symbolMatch =
        s.match(/\bfind symbol[:\s]+([\w]{3,})/i) ||
        step.match(/\blocate\b\s+([A-Z][a-z][\w]{2,})/);
    if (symbolMatch) {
        return JSON.stringify({ tool: "project_find_symbol", args: { project, name: symbolMatch[symbolMatch.length - 1] } });
    }

    if (/\b(build and fix|build_and_fix|auto.?fix|run build and fix)\b/.test(s))
        return JSON.stringify({ tool: "project_build_and_fix", args: { project } });

    if (/\b(run build|npm run build|gradlew build|mvn|compile)\b/.test(s))
        return JSON.stringify({ tool: "project_build", args: { project } });

    if (/\b(analyze|analyse|static.?analy|lint|check imports|run static analysis|identify issues)\b/.test(s))
        return JSON.stringify({ tool: "project_analyze", args: { project } });

    if (/\b(list projects|available projects|what projects)\b/.test(s))
        return JSON.stringify({ tool: "project_list", args: {} });

    if (/\b(show diff|git diff|what changed|uncommitted|review changes)\b/.test(s))
        return JSON.stringify({ tool: "project_diff", args: { project } });

    if (/\b(git log|commit history|recent commits|what was committed)\b/.test(s))
        return JSON.stringify({ tool: "project_git_log", args: { project } });

    if (/\b(run tests|run test suite|run project tests|execute tests|verify tests|confirm tests|npm test|pytest|go test)\b/.test(s))
        return JSON.stringify({ tool: "project_test", args: { project } });

    return null;
}

// ─── Arg normaliser ──────────────────────────────────────────────────────────────────────────
function normalizeArgs(tool, args, project) {
    if (!args) args = {};
    args.project = project;
    if (tool === "project_read_files") {
        if (args.file) { args.paths = [args.file]; delete args.file; }
        if (typeof args.paths === "string") args.paths = [args.paths];
        if (!args.paths) args.paths = [];
    }
    if (tool === "project_apply_changes") {
        if (!args.files)         args.files         = [];
        if (!args.commitMessage) args.commitMessage = "AI generated change";
    }
    if (tool === "project_str_replace") {
        if (!args.edits)         args.edits         = [];
        if (!args.commitMessage) args.commitMessage = "AI str-replace edit";
    }
    return args;
}

// Hoist top-level keys the model accidentally put outside "args"
function hoistTopLevelArgs(parsed) {
    const known = new Set(["tool", "args", "done"]);
    const extra = Object.keys(parsed).filter(k => !known.has(k));
    if (extra.length > 0) {
        if (!parsed.args) parsed.args = {};
        for (const key of extra) {
            if (parsed.args[key] === undefined) parsed.args[key] = parsed[key];
            delete parsed[key];
        }
    }
    return parsed;
}

// ─── Main entry ───────────────────────────────────────────────────────────────────────────────
/**
 * Execute a single plan step.
 *
 * @param {string}         step       - natural-language step description
 * @param {string}         context    - compiled execution context
 * @param {string}         project
 * @param {string}         memoryCtx  - optional memory context
 * @param {object}         costState  - { llmCalls } mutated in place
 * @param {ExecutionState} execState  - live execution state
 */
export async function executeStep(step, context, project, memoryCtx = "", costState = null, execState = null) {

    // 1. Rule-based routing (zero LLM cost)
    const ruled = routeByRule(step, project);
    if (ruled) {
        if (execState) {
            try {
                const parsed = JSON.parse(ruled);
                if (parsed.tool === "project_read_files" && Array.isArray(parsed.args?.paths)) {
                    const unstale = parsed.args.paths.filter(p => {
                        const wasRead     = execState.hasRead(p);
                        const wasModified = execState.hasModified(p);
                        if (wasModified) return true;
                        if (wasRead)     return false;
                        return true;
                    });
                    if (unstale.length === 0) {
                        console.error(`[executor] ⚡ Skipping read — files already read and unmodified: ${parsed.args.paths.join(", ")}`);
                        return JSON.stringify({ skipped: true, reason: "already_read" });
                    }
                    if (unstale.length < parsed.args.paths.length) {
                        const skipped = parsed.args.paths.filter(p => !unstale.includes(p));
                        console.error(`[executor] ⚡ Partial skip — skipping unmodified reads: ${skipped.join(", ")}`);
                        parsed.args.paths = unstale;
                        return JSON.stringify(parsed);
                    }
                }
            } catch { /* not JSON — fall through */ }
        }
        console.error("[executor] Rule-matched (no LLM call)");
        return ruled;
    }

    // 2. Cost guard
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[executor] LLM budget exhausted — skipping LLM call for this step");
        return JSON.stringify({ done: true });
    }

    // 3. Build memory block
    const memoryBlock = memoryCtx ? `\nRelevant project memory:\n${memoryCtx}\n` : "";

    // 4. LLM call — prompt assembled from src/prompts/executor.js
    if (costState) costState.llmCalls++;
    const prompt = buildExecutorPrompt(context, step, memoryBlock);

    try {
        const raw  = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: NUM_PREDICT.executor });
        const text = extractJSON(raw);
        if (!text) return JSON.stringify({ done: true });

        let parsed = JSON.parse(text);
        parsed = hoistTopLevelArgs(parsed);

        if (parsed.tool && parsed.args) {
            parsed.args = normalizeArgs(parsed.tool, parsed.args, project);
        }

        return JSON.stringify(parsed);
    } catch (err) {
        console.error("[executor] LLM parse error:", err.message);
        return JSON.stringify({ tool: "project_analyze", args: { project } });
    }
}
