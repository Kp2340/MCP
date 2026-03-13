import fetch from "node-fetch";

const MODEL = "qwen2.5-coder:7b";

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function cleanJSON(text) {

    if (!text) return "";

    return text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
}

function normalizeArgs(tool, args, project) {

    if (!args) args = {};

    /*
    Always enforce project
    */
    args.project = project;

    /*
    Fix read_files
    */
    if (tool === "project_read_files") {

        if (args.file) {
            args.paths = [args.file];
            delete args.file;
        }

        if (typeof args.paths === "string") {
            args.paths = [args.paths];
        }

        if (!args.paths) {
            args.paths = [];
        }
    }

    /*
    Fix apply_changes
    */
    if (tool === "project_apply_changes") {

        if (!args.files) args.files = [];

        if (!args.commitMessage) {
            args.commitMessage = "AI generated change";
        }
    }

    return args;
}

async function callLLM(prompt) {

    for (let i = 0; i < 3; i++) {

        try {

            const res = await fetch("http://localhost:11434/api/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: MODEL,
                    prompt,
                    stream: false
                })
            });

            const json = await res.json();

            return json.response;

        } catch (err) {

            console.log("LLM retry...");
            await sleep(2000);

        }
    }

    throw new Error("LLM connection failed");
}

export async function executeStep(step, context, project) {

    const prompt = `
You are an AI coding agent.

Context:
${context}

Step:
${step}

You can call tools.

Return ONLY JSON.

Example format:

{
  "tool": "project_read_files",
  "args": {
    "project": "${project}",
    "paths": ["src/file.js"]
  }
}

Available tools:

project_read_files
{
 "project": "string",
 "paths": ["file1","file2"]
}

project_search
{
 "project": "string",
 "query": "string"
}

project_find_symbol
{
 "project": "string",
 "name": "symbol"
}

project_apply_changes
{
 "project": "string",
 "files": [
  { "path": "file", "content": "code" }
 ],
 "commitMessage": "message"
}

project_build_and_fix
{
 "project": "string"
}

Rules:
- JSON only
- No markdown
- Do not invent project names
`;

    const raw = await callLLM(prompt);

    const cleaned = cleanJSON(raw);

    try {

        const parsed = JSON.parse(cleaned);

        if (parsed.tool) {
            parsed.args = normalizeArgs(parsed.tool, parsed.args, project);
        }

        return JSON.stringify(parsed);

    } catch (err) {

        console.log("\nInvalid JSON from model:");
        console.log(raw);

        return raw;
    }
}