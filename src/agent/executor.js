import { askLLM } from "./ollamaClient.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { MAX_LLM_CALLS_PER_RUN, LLM_MODEL, NUM_PREDICT } from "../core/constants.js";

const MODEL = LLM_MODEL;

// ─── Rule-based tool router ────────────────────────────────────────────────────
// Fires BEFORE the LLM. If a step matches a confident rule the LLM call is
// skipped entirely — zero tokens, zero latency.
function routeByRule(step, project) {
    const s = step.toLowerCase();

    // Scan / list structure
    if (/\b(scan|list files|folder structure|project structure)\b/.test(s))
        return JSON.stringify({ tool: "project_scan", args: { project } });

    // Symbol lookup — handles various phrasings:
    // "Find the relevant component symbol in the project index"
    // "find symbol Foo", "locate class Bar", "Find the Footer component"
    // Strategy: extract the last PascalCase word in the step as the symbol name.
    // Fall back to explicit keyword+name patterns.
    if (/\b(find|locate|look up)\b.*(symbol|class|function|component|service|controller)/i.test(s)) {
        // Extract all PascalCase words from the original step
        const pascalWords = step.match(/\b[A-Z][a-z][\w]{1,}\b/g) || [];
        // Filter out generic English words
        const genericWords = new Set(["Find", "Read", "Run", "Apply", "Create", "Check", "Build", "Use",
            "The", "This", "That", "With", "From", "Into", "After", "Before"]);
        const symbolName = pascalWords.filter(w => !genericWords.has(w)).pop();
        if (symbolName) {
            return JSON.stringify({ tool: "project_find_symbol", args: { project, name: symbolName } });
        }
        // No PascalCase found — let LLM handle it instead of guessing
        return null;
    }
    // Explicit: "find symbol Foo" or "locate Foo"
    const symbolMatch =
        s.match(/\bfind symbol[:\s]+([\w]{3,})/i) ||
        step.match(/\blocate\b\s+([A-Z][a-z][\w]{2,})/);
    if (symbolMatch) {
        const name = symbolMatch[symbolMatch.length - 1];
        return JSON.stringify({ tool: "project_find_symbol", args: { project, name } });
    }

    // Build + fix
    if (/\b(build and fix|build_and_fix|auto.?fix|run build and fix)\b/.test(s))
        return JSON.stringify({ tool: "project_build_and_fix", args: { project } });

    // Plain build
    if (/\b(run build|npm run build|gradlew build|mvn|compile)\b/.test(s))
        return JSON.stringify({ tool: "project_build", args: { project } });

    // Static analysis
    if (/\b(analyze|analyse|static.?analy|lint|check imports|run static analysis|identify issues)\b/.test(s))
        return JSON.stringify({ tool: "project_analyze", args: { project } });

    // List projects
    if (/\b(list projects|available projects|what projects)\b/.test(s))
        return JSON.stringify({ tool: "project_list", args: {} });

    // Show diff / uncommitted changes
    if (/\b(show diff|git diff|what changed|uncommitted|review changes)\b/.test(s))
        return JSON.stringify({ tool: "project_diff", args: { project } });

    // Git log / commit history
    if (/\b(git log|commit history|recent commits|what was committed)\b/.test(s))
        return JSON.stringify({ tool: "project_git_log", args: { project } });

    return null;
}

// ─── Arg normaliser ──────────────────────────────────────────────────────────
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

// ─── Main entry ──────────────────────────────────────────────────────────────
/**
 * Execute a single plan step.
 *
 * @param {string}         step          - natural-language step description
 * @param {string}         context       - execution context (compressed history + RAG)
 * @param {string}         project
 * @param {string}         [memoryCtx]   - relevant memory entries to inject (optional)
 * @param {object}         [costState]   - { llmCalls: number } mutated in place
 * @param {ExecutionState} [execState]   - active state used to skip redundant reads
 */
export async function executeStep(step, context, project, memoryCtx = "", costState = null, execState = null) {

    // 1. Rule-based routing (zero LLM cost)
    const ruled = routeByRule(step, project);
    if (ruled) {
        // Active ExecutionState gate: skip reads of already-known files,
        // and skip str_replace on already-modified files (prevent double edits)
        if (execState) {
            try {
                const parsed = JSON.parse(ruled);

                // Skip read if file already read or modified (we have the content)
                if (parsed.tool === "project_read_files" && Array.isArray(parsed.args?.paths)) {
                    const unstale = parsed.args.paths.filter(p => !execState.hasRead(p) && !execState.hasModified(p));
                    if (unstale.length === 0) {
                        console.error(`[executor] ⚡ Skipping read — all files already in state: ${parsed.args.paths.join(", ")}`);
                        return JSON.stringify({ skipped: true, reason: "already_read" });
                    }
                    if (unstale.length < parsed.args.paths.length) {
                        console.error(`[executor] ⚡ Partial skip — only reading new files: ${unstale.join(", ")}`);
                        parsed.args.paths = unstale;
                        return JSON.stringify(parsed);
                    }
                }

                // Skip str_replace if edits target only already-modified files
                if (parsed.tool === "project_str_replace" && Array.isArray(parsed.args?.edits)) {
                    const newEdits = parsed.args.edits.filter(e => !execState.hasModified(e.path));
                    if (newEdits.length === 0) {
                        console.error(`[executor] ⚡ Skipping str_replace — all target files already modified`);
                        return JSON.stringify({ skipped: true, reason: "already_modified" });
                    }
                }
            } catch { /* not JSON — fall through */ }
        }
        console.error("[executor] Rule-matched (no LLM call)");
        return ruled;
    }

    // 2. Cost guard — if budget is exhausted, emit a safe no-op
    if (costState && costState.llmCalls >= MAX_LLM_CALLS_PER_RUN) {
        console.error("[executor] LLM budget exhausted — skipping LLM call for this step");
        return JSON.stringify({ done: true });
    }

    // 3. Build memory injection block
    const memoryBlock = memoryCtx
        ? `\nRelevant project memory:\n${memoryCtx}\n`
        : "";

    // 3b. Active ExecutionState gate for LLM-resolved steps (applied post-parse below)
    // (Nothing to do here pre-LLM — gate runs on LLM output)

    // 4. LLM call for ambiguous steps
    if (costState) costState.llmCalls++;

    const prompt = `You are a deterministic coding executor operating via MCP (Model Context Protocol).
Output ONLY a single JSON object. No explanation, no markdown, no text before or after.

## CORE RULES
- NEVER explain. ONLY output a JSON tool call.
- ALWAYS prefer project_str_replace over project_apply_changes for edits.
- NEVER read the same file twice.
- NEVER modify the same file twice unless fixing a new error.
- ALWAYS use the SMALLEST fix possible (targeted str_replace, not full rewrites).
- Output MUST be { "tool": "...", "args": { ... } } OR { "done": true }

## EXECUTION STATE CONSTRAINTS
You are given execution state:
- Files already read: DO NOT read again
- Files already modified: DO NOT modify again unless fixing a NEW error
- Last error type: prioritize fixing it deterministically
Violating these rules will cause redundant operations and must be avoided.

## PRIORITY ORDER (follow strictly)
1. Deterministic recovery (if error exists: identify → fix → verify)
2. Tool-chain execution (use matching tool directly)
3. Pattern-matched action (from memory/context)
4. LLM reasoning (LAST resort only)

## ERROR RECOVERY (deterministic, no planning)
- import_error  → project_search → project_read_files → project_str_replace → project_analyze
- syntax_error  → project_read_files → project_str_replace → project_analyze
- build_failure → project_analyze → project_str_replace → project_build
- runtime_error → project_analyze → project_read_files → project_str_replace

## ERROR FIXING PRIORITY
If an error is present:
- Prefer deterministic fixes (like commenting/removing bad imports)
- DO NOT attempt complex reasoning fixes
- Use the smallest possible change to unblock the system

## TOOL USAGE STRATEGY
- Reading code: project_search or project_find_symbol FIRST, then project_read_files
- Editing code: ALWAYS project_str_replace (never apply_changes for small edits)
- Fixing errors: project_analyze FIRST, then minimal str_replace, then build

## FAIL FAST RULE
If unsure what to do:
- DO NOT guess
- Run project_analyze instead

Context:
${context}${memoryBlock}
Step to execute:
${step}

Available tools:

project_scan        — { "tool": "project_scan",        "args": { "project": "string" } }
project_search      — { "tool": "project_search",      "args": { "project": "string", "query": "string" } }
project_find_symbol — { "tool": "project_find_symbol", "args": { "project": "string", "name": "string" } }
project_read_files  — { "tool": "project_read_files",  "args": { "project": "string", "paths": ["file"] } }
project_str_replace — {
  "tool": "project_str_replace",
  "args": {
    "project": "string",
    "edits": [{ "path": "relative/path", "search": "exact string", "replace": "replacement" }],
    "commitMessage": "message"
  }
}
project_apply_changes — {
  "tool": "project_apply_changes",
  "args": {
    "project": "string",
    "files": [{ "path": "relative/path", "content": "full file content" }],
    "commitMessage": "message"
  }
}
project_build_and_fix — { "tool": "project_build_and_fix", "args": { "project": "string" } }
project_analyze       — { "tool": "project_analyze",       "args": { "project": "string" } }
project_diff          — { "tool": "project_diff",          "args": { "project": "string" } }
project_git_log       — { "tool": "project_git_log",       "args": { "project": "string", "count": 10 } }

Constraints:
- All args MUST be inside the "args" key
- project is always: ${project}
- Output ONLY the JSON object

JSON:`;

    // Use larger budget only when the step involves writing full file content
    const isApplyStep = /apply.?change|new file|create file/i.test(step);
    const numPredict  = isApplyStep ? NUM_PREDICT.executor_apply : NUM_PREDICT.executor;
    const raw         = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: numPredict });
    const extracted = extractJSON(raw);

    try {
        let parsed = JSON.parse(extracted);
        if (parsed.tool) {
            parsed = hoistTopLevelArgs(parsed);
            parsed.args = normalizeArgs(parsed.tool, parsed.args, project);

            // Active ExecutionState gate on LLM-suggested reads + edits
            if (execState) {
                // Skip reads of already-known (read or modified) files
                if (parsed.tool === "project_read_files" && Array.isArray(parsed.args?.paths)) {
                    const unstale = parsed.args.paths.filter(p => !execState.hasRead(p) && !execState.hasModified(p));
                    if (unstale.length === 0) {
                        console.error(`[executor] ⚡ LLM suggested reading already-known files — skipping: ${parsed.args.paths.join(", ")}`);
                        return JSON.stringify({ skipped: true, reason: "already_read" });
                    }
                    if (unstale.length < parsed.args.paths.length) {
                        console.error(`[executor] ⚡ Partial skip (LLM): keeping only new: ${unstale.join(", ")}`);
                        parsed.args.paths = unstale;
                    }
                }
                // Skip str_replace on already-modified files
                if (parsed.tool === "project_str_replace" && Array.isArray(parsed.args?.edits)) {
                    const newEdits = parsed.args.edits.filter(e => !execState.hasModified(e.path));
                    if (newEdits.length === 0) {
                        console.error(`[executor] ⚡ LLM suggested str_replace on already-modified files — skipping`);
                        return JSON.stringify({ skipped: true, reason: "already_modified" });
                    }
                }
            }
        }
        return JSON.stringify(parsed);
    } catch {
        console.warn("\n[executor] Could not parse model output:");
        console.warn(raw);
        return raw;
    }
}
