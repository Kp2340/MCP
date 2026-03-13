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

        if (args.path && args.content) {
            args.files = [{
                path: args.path,
                content: args.content
            }];
            delete args.path;
            delete args.content;
        }

        if (!args.commitMessage)
            args.commitMessage = "AI generated change";
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
    const prompt = `You are an AI coding agent.

Return ONLY JSON.

Context:
${context}

Step:
${step}

Tools:
project_scan
project_search
project_find_symbol
project_read_files
project_apply_search_replace
project_apply_changes
project_build_and_fix

Format:
{"tool":"name","args":{}}
`;

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
