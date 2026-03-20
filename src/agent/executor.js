import { askLLM } from "./ollamaClient.js";
import { extractJSON } from "../utils/jsonUtils.js";

const MODEL = "qwen2.5-coder:7b";

// ─── Rule-based tool router ──────────────────────────────────────────────────
// Fires BEFORE the LLM. If a step matches a confident rule the LLM call is
// skipped entirely — saves tokens and latency.
//
// Returns a pre-built JSON string, or null if no rule matched.
function routeByRule(step, project) {
    const s = step.toLowerCase();

    // Scan / list structure
    if (/\b(scan|list files|folder structure|project structure)\b/.test(s))
        return JSON.stringify({ tool: "project_scan", args: { project } });

    // Symbol lookup
    const symbolMatch = s.match(/\b(find|locate|look up)\b.+\b(class|function|component|service|controller|symbol)\b[:\s]+([\w]+)/i)
                     || s.match(/\bfind symbol[:\s]+([\w]+)/i);
    if (symbolMatch) {
        const name = symbolMatch[symbolMatch.length - 1];
        return JSON.stringify({ tool: "project_find_symbol", args: { project, name } });
    }

    // Build
    if (/\b(build and fix|build_and_fix|auto.?fix)\b/.test(s))
        return JSON.stringify({ tool: "project_build_and_fix", args: { project } });

    if (/\b(run build|npm run build|gradlew build|mvn|compile)\b/.test(s))
        return JSON.stringify({ tool: "project_build", args: { project } });

    // Static analysis
    if (/\b(analyze|analyse|static.?analy|lint|check imports)\b/.test(s))
        return JSON.stringify({ tool: "project_analyze", args: { project } });

    // No confident match — fall through to LLM
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

// Hoist top-level keys the model put outside "args" back in
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
export async function executeStep(step, context, project) {

    // 1. Try rule-based routing first (zero LLM cost)
    const ruled = routeByRule(step, project);
    if (ruled) {
        console.error("[executor] Rule-matched (no LLM call)");
        return ruled;
    }

    // 2. Fall back to LLM for ambiguous steps
    const prompt = `You are an AI coding agent. Output ONLY a single JSON object. No explanation, no markdown, no text before or after.

Context:
${context}

Step to execute:
${step}

Available tools:

project_scan        — { "tool": "project_scan", "args": { "project": "string" } }
project_search      — { "tool": "project_search", "args": { "project": "string", "query": "string" } }
project_find_symbol — { "tool": "project_find_symbol", "args": { "project": "string", "name": "string" } }
project_read_files  — { "tool": "project_read_files", "args": { "project": "string", "paths": ["file"] } }
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

Rules:
- Prefer project_str_replace over project_apply_changes for small edits
- Output ONLY the JSON object, nothing else
- All args MUST be inside the "args" key
- project is always: ${project}

JSON:`;

    const raw       = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 2048 });
    const extracted = extractJSON(raw);

    try {
        let parsed = JSON.parse(extracted);
        if (parsed.tool) {
            parsed = hoistTopLevelArgs(parsed);
            parsed.args = normalizeArgs(parsed.tool, parsed.args, project);
        }
        return JSON.stringify(parsed);
    } catch {
        console.warn("\n[executor] Could not parse model output:");
        console.warn(raw);
        return raw;
    }
}
