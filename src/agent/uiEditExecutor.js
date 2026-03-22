/**
 * UI Edit Executor
 *
 * Handles the "ui_edit" template with a smart pipeline:
 * 1. Find the component via project_find_symbol or project_search
 * 2. Read the actual file content
 * 3. Use LLM with the REAL file content to generate a precise str_replace
 * 4. Apply the str_replace
 * 5. Build and verify
 *
 * This eliminates the #1 agent failure: LLM hallucinating search strings
 * that don't exist in the file.
 */

import { askLLM } from "./ollamaClient.js";
import { extractJSON } from "../utils/jsonUtils.js";
import { LLM_MODEL, NUM_PREDICT } from "../core/constants.js";

const MODEL = LLM_MODEL;

/**
 * Extract component name from prompt.
 * e.g. "Add X to the footer" → "Footer"
 *      "Update the navbar color" → "Navbar" (or "navbar")
 */
function extractComponentFromPrompt(prompt) {
    // Common UI component keywords
    const UI_COMPONENTS = [
        "footer", "header", "navbar", "nav", "sidebar", "banner",
        "hero", "layout", "page", "button", "form", "modal", "card",
        "menu", "drawer", "toast", "alert", "badge", "tab", "table"
    ];

    const lower = prompt.toLowerCase();
    for (const comp of UI_COMPONENTS) {
        if (lower.includes(comp)) {
            // Return PascalCase version
            return comp.charAt(0).toUpperCase() + comp.slice(1);
        }
    }

    // Fall back to any PascalCase word in the prompt
    const pascalMatch = prompt.match(/\b([A-Z][a-z][\w]{2,})\b/);
    return pascalMatch ? pascalMatch[1] : null;
}

/**
 * Smart UI edit pipeline.
 *
 * @param {string}         prompt    - original user prompt
 * @param {string}         project
 * @param {MCPClient}      mcpClient
 * @param {ExecutionState} execState
 * @param {object}         costState
 * @returns {{ success: boolean, stepsRun: number, results: string[] }}
 */
export async function executeUiEdit(prompt, project, mcpClient, execState, costState) {
    const results  = [];
    let stepsRun   = 0;
    let filePath   = null;
    let fileContent = null;

    // ── Step 1: Find component ────────────────────────────────────────────────
    const componentName = extractComponentFromPrompt(prompt);

    if (componentName) {
        try {
            console.error(`[uiEdit] Looking up symbol: ${componentName}`);
            const symbolResult = await mcpClient.callTool("project_find_symbol", { project, name: componentName });
            const symbolText   = symbolResult?.content?.map(c => c.text || "").join("
") || "";
            execState.recordToolCall("project_find_symbol", { project, name: componentName }, symbolText, ++stepsRun);
            results.push(`[project_find_symbol]:
${symbolText}`);

            // Parse file path from result like: "function Footer  →  src\components\Footer.tsx:116"
            const pathMatch = symbolText.match(/→\s*([^
:]+\.(?:tsx?|jsx?|java|kt|py))/);
            if (pathMatch) {
                filePath = pathMatch[1].trim().replace(/\\/g, "/");
                console.error(`[uiEdit] Found file: ${filePath}`);
            }
        } catch (err) {
            console.error(`[uiEdit] Symbol lookup failed: ${err.message}`);
        }
    }

    // If symbol lookup failed, try searching
    if (!filePath && componentName) {
        try {
            console.error(`[uiEdit] Searching for: ${componentName}`);
            const searchResult = await mcpClient.callTool("project_search", { project, query: componentName });
            const searchText   = searchResult?.content?.map(c => c.text || "").join("
") || "";
            execState.recordToolCall("project_search", { project, query: componentName }, searchText, ++stepsRun);

            // Extract first .tsx/.jsx file from results
            const fileMatch = searchText.match(/([^\s:]+\.(?:tsx?|jsx?))/);
            if (fileMatch) {
                filePath = fileMatch[1].replace(/\\/g, "/");
                console.error(`[uiEdit] Found via search: ${filePath}`);
            }
        } catch (err) {
            console.error(`[uiEdit] Search failed: ${err.message}`);
        }
    }

    if (!filePath) {
        console.error(`[uiEdit] Could not locate component file`);
        return { success: false, stepsRun, results };
    }

    // ── Step 2: Read actual file content ─────────────────────────────────────
    try {
        console.error(`[uiEdit] Reading file: ${filePath}`);
        const readResult  = await mcpClient.callTool("project_read_files", { project, paths: [filePath] });
        const readText    = readResult?.content?.map(c => c.text || "").join("
") || "";
        execState.recordToolCall("project_read_files", { project, paths: [filePath] }, readText, ++stepsRun);
        results.push(`[project_read_files]:
${readText}`);

        // Extract actual file content from JSON result
        try {
            const parsed = JSON.parse(readText);
            fileContent  = parsed[0]?.content || null;
        } catch {
            fileContent = readText;
        }
    } catch (err) {
        console.error(`[uiEdit] Read failed: ${err.message}`);
        return { success: false, stepsRun, results };
    }

    if (!fileContent) {
        console.error(`[uiEdit] File content empty`);
        return { success: false, stepsRun, results };
    }

    // ── Step 3: LLM generates precise str_replace using REAL content ──────────
    // Try up to 2 attempts: first with a focused snippet, then with full file if search fails
    const isBottomRequest = /bottom|footer|end|last|below|after|append/i.test(prompt);

    const buildEditPrompt = (snippet, sectionLabel) =>
        `You are a precise code editor. Output ONLY a JSON object.

User request: ${prompt}

File: ${filePath}
File content (${sectionLabel}):
\`\`\`
${snippet}
\`\`\`

Your task: make the minimal change to fulfill the user request.

Output ONLY this JSON:
{
  "search": "<exact string copied verbatim from the file above>",
  "replace": "<the same string with your change applied>"
}

CRITICAL RULES:
- "search" MUST exist VERBATIM in the file — copy it character-for-character
- Choose a UNIQUE anchor: 2-3 lines that appear only ONCE in the file
- "replace" = the search string WITH your addition included
- NEVER modify unrelated code
- For adding text at the bottom: use the closing tags as your anchor
- Output ONLY the JSON, no explanation

JSON:`;

    const normalizedContent = fileContent.replace(/\r
/g, "
");

    // Attempt 1: focused snippet (faster, cheaper)
    const snippet1 = isBottomRequest
        ? fileContent.slice(-3000)
        : fileContent.substring(0, 6000);
    const label1 = isBottomRequest ? "bottom section" : "top section";

    let editArgs = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const snippet = attempt === 1 ? snippet1 : fileContent.substring(0, 10000);
        const label   = attempt === 1 ? label1   : "full file";

        if (costState) costState.llmCalls++;
        const raw       = await askLLM(MODEL, buildEditPrompt(snippet, label), { temperature: 0.0, num_predict: 1000 });
        const extracted = extractJSON(raw);

        try {
            const parsed = JSON.parse(extracted);
            if (!parsed.search || !parsed.replace) throw new Error("Missing search or replace");

            const normalizedSearch = parsed.search.replace(/\r
/g, "
").trim();
            if (!normalizedContent.includes(normalizedSearch)) {
                console.error(`[uiEdit] Attempt ${attempt}: search string not found — ${normalizedSearch.substring(0, 80)}`);
                if (attempt < 2) continue;  // retry with full file
                console.error(`[uiEdit] Both attempts failed to produce a valid search string`);
                return { success: false, stepsRun, results };
            }

            parsed.search = normalizedSearch;
            editArgs = {
                project,
                edits: [{ path: filePath, search: parsed.search, replace: parsed.replace }],
                commitMessage: `UI edit: ${prompt.substring(0, 60)}`
            };
            break;
        } catch (err) {
            console.error(`[uiEdit] Attempt ${attempt} parse error: ${err.message}`);
            if (attempt >= 2) return { success: false, stepsRun, results };
        }
    }

    if (!editArgs) return { success: false, stepsRun, results };

    // ── Step 4: Apply the str_replace ────────────────────────────────────────
    try {
        console.error(`[uiEdit] Applying str_replace to ${filePath}`);
        const applyResult = await mcpClient.callTool("project_str_replace", editArgs);
        const applyText   = applyResult?.content?.map(c => c.text || "").join("
") || "";
        execState.recordToolCall("project_str_replace", editArgs, applyText, ++stepsRun);
        results.push(`[project_str_replace]:
${applyText}`);
        console.error(`[uiEdit] ${applyText}`);
    } catch (err) {
        console.error(`[uiEdit] str_replace failed: ${err.message}`);
        return { success: false, stepsRun, results };
    }

    // ── Step 5: Build and verify ──────────────────────────────────────────────
    let buildPassed = true;
    try {
        console.error(`[uiEdit] Running build verification`);
        const buildResult = await mcpClient.callTool("project_build_and_fix", { project });
        const buildText   = buildResult?.content?.map(c => c.text || "").join("
") || "";
        execState.recordToolCall("project_build_and_fix", { project }, buildText, ++stepsRun);
        results.push(`[project_build_and_fix]:
${buildText}`);
        // Detect build failures explicitly so the agent loop can inject recovery steps
        buildPassed = !(/BUILD FAILED|BUILD TIMEOUT/i.test(buildText));
        console.error(`[uiEdit] Build ${buildPassed ? "passed ✅" : "failed ❌"}: ${buildText.substring(0, 120)}`);
    } catch (err) {
        buildPassed = false;
        console.error(`[uiEdit] Build threw: ${err.message}`);
        results.push(`[project_build_and_fix ERROR]: ${err.message}`);
    }

    // Return success based on whether build passed
    // The calling agent loop checks success and may inject recovery steps if false
    return { success: buildPassed, stepsRun, results };
}
