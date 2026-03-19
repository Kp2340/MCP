import { askLLM } from "./ollamaClient.js";
import { extractJSON } from "../utils/jsonUtils.js";

const MODEL = "qwen2.5-coder:7b";

/**
 * Normalize args after parsing:
 * - Always sets project
 * - Hoists top-level keys the model put outside "args" back in
 * - Fixes common field name mistakes per tool
 */
function normalizeArgs(tool, args, project) {
    if (!args) args = {};

    // Enforce correct project
    args.project = project;

    // Fix read_files: model sometimes uses "file" or passes a string
    if (tool === "project_read_files") {
        if (args.file) { args.paths = [args.file]; delete args.file; }
        if (typeof args.paths === "string") args.paths = [args.paths];
        if (!args.paths) args.paths = [];
    }

    // Fix apply_changes defaults
    if (tool === "project_apply_changes") {
        if (!args.files) args.files = [];
        if (!args.commitMessage) args.commitMessage = "AI generated change";
    }

    return args;
}

/**
 * The model sometimes puts args at top level instead of inside "args".
 * E.g.: { "tool": "project_find_symbol", "name": "Foo", "args": {} }
 * Hoist unknown top-level keys into args.
 */
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

export async function executeStep(step, context, project) {
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
project_apply_changes — {
  "tool": "project_apply_changes",
  "args": {
    "project": "string",
    "files": [{ "path": "relative/path", "content": "full file content" }],
    "commitMessage": "message"
  }
}
project_build_and_fix — { "tool": "project_build_and_fix", "args": { "project": "string" } }

Rules:
- Output ONLY the JSON object, nothing else
- All args MUST be inside the "args" key
- project is always: ${project}

JSON:`;

    const raw = await askLLM(MODEL, prompt, { temperature: 0.1, num_predict: 2048 });
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