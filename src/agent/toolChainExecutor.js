/**
 * Tool Chain Executor — P0 upgrade
 *
 * Directly executes a named TOOL_CHAIN_TEMPLATES entry without any LLM calls.
 * Each step in the template is resolved via rule-based routing from executor.js.
 *
 * This replaces the old pattern where:
 *   heuristic plan found → LLM still called per step → tools run
 *
 * New pattern:
 *   heuristic plan found → toolChainExecutor runs steps directly → done
 *
 * Usage:
 *   const { results, success } = await executeToolChain("fix_error", project, mcp, execState, costState);
 */

import { TOOL_CHAIN_TEMPLATES } from "../core/constants.js";

// ── Tool allowlist ──────────────────────────────────────────────────────────────────────────────────
// Only tools in this set can be dispatched by toolChainExecutor.
// Any tool NOT in this list — even if the LLM or a template requests it —
// is blocked with a hard error. This prevents prompt injection and runaway
// LLM-directed tool calls from reaching destructive or unintended operations.
const ALLOWED_TOOLS = new Set([
    "project_scan",
    "project_read_files",
    "project_find_symbol",
    "project_search",
    "project_analyze",
    "project_str_replace",
    "project_apply_changes",
    "project_apply_patch",
    "project_build",
    "project_build_and_fix",
    "project_test",
    "project_diff",
    "project_git_log",
    "project_index",
    "project_rename_symbol",
    "project_rename_symbol_all",
    "project_dependency_graph",
    "project_register",
]);

/**
 * Validate that a tool is in the allowlist before dispatching.
 * Throws a descriptive error if the tool is not permitted.
 * @param {string} toolName
 */
function assertToolAllowed(toolName) {
    if (!ALLOWED_TOOLS.has(toolName)) {
        throw new Error(
            `[toolChain] Tool "${toolName}" is not in ALLOWED_TOOLS. ` +
            `Permitted tools: ${[...ALLOWED_TOOLS].join(", ")}`
        );
    }
}

// ─── Rule router (duplicated from executor to avoid circular dep) ─────────────
// This mirrors the routing logic in executor.js without the LLM path.
function resolveStepToTool(step, project) {
    const s = step.toLowerCase();

    if (/\b(scan|list files|folder structure|project structure)\b/.test(s))
        return { tool: "project_scan", args: { project } };

    const symbolMatch =
        s.match(/\b(?:find|locate|look up)\b.+\b(?:class|function|component|service|controller|symbol)\b[:\s]+([\w]+)/i) ||
        s.match(/\bfind symbol[:\s]+([\w]+)/i);
    if (symbolMatch) {
        const name = symbolMatch[symbolMatch.length - 1];
        return { tool: "project_find_symbol", args: { project, name } };
    }

    if (/\b(build and fix|build_and_fix|auto.?fix|run build and fix)\b/.test(s))
        return { tool: "project_build_and_fix", args: { project } };

    if (/\b(run build|npm run build|gradlew build|mvn|compile)\b/.test(s))
        return { tool: "project_build", args: { project } };

    if (/\b(analyze|analyse|static.?analy|lint|check imports|run static analysis|identify issues)\b/.test(s))
        return { tool: "project_analyze", args: { project } };

    if (/\b(search|find files|look for|grep)\b/.test(s))
        return { tool: "project_search", args: { project, query: step.replace(/^(search|find|look for)\s*/i, "").trim() } };

    // Rename symbol routing — mirrors executor.js rule router
    const renameAllPattern = s.match(/\brename\b.+\b(across|all|everywhere|project.?wide|globally)\b/i)
        || s.match(/\b(global|project.?wide)\b.+\brename\b/i);
    const symbolPair = step.match(/\brename\b\s+(\w+)\s+(?:to|->|=>|as)\s+(\w+)/i);
    if (renameAllPattern && symbolPair) {
        return { tool: "project_rename_symbol_all", args: { project, oldName: symbolPair[1], newName: symbolPair[2] } };
    }
    if (symbolPair) {
        return { tool: "project_rename_symbol_all", args: { project, oldName: symbolPair[1], newName: symbolPair[2] } };
    }

    if (/\bproject_rename_symbol_all\b/.test(s)) {
        return { tool: "project_rename_symbol_all", args: { project, oldName: "", newName: "" } };
    }

    // Cannot resolve without LLM
    return null;
}

/**
 * Execute a predefined list of { tool, args } objects directly — ZERO LLM calls.
 * Used by deterministic failure recovery to run structured tool sequences.
 *
 * @param {Array<{tool:string,args:object}>} toolSteps
 * @param {MCPClient}                        mcpClient
 * @param {ExecutionState}                   execState
 * @returns {{ results: string[], success: boolean, stepsRun: number }}
 */
export async function executeToolsDirect(toolSteps, mcpClient, execState) {
    if (!toolSteps || toolSteps.length === 0) {
        return { results: [], success: false, stepsRun: 0 };
    }

    console.error(`
[toolChain] ⚡ Direct recovery: ${toolSteps.length} tool call(s), 0 LLM`);

    const results = [];
    let stepsRun  = 0;
    let anyFailed = false;

    for (const { tool, args } of toolSteps) {
        assertToolAllowed(tool);  // Hard block — must precede every callTool dispatch

        // ExecutionState skip-gate for reads
        if (tool === "project_read_files" && Array.isArray(args?.paths)) {
            const unread = args.paths.filter(p => !execState.hasRead(p));
            if (unread.length === 0) {
                console.error(`[toolChain]   ⚡ Skip already-read: ${args.paths.join(", ")}`);
                continue;
            }
            args.paths = unread;
        }

        console.error(`[toolChain]   → ${tool}`);
        stepsRun++;

        try {
            const result    = await mcpClient.callTool(tool, args);
            const resultText = result?.content?.map(c => c.text || "").join("
").substring(0, 3000) || "";

            execState.recordToolCall(tool, args, resultText, stepsRun);
            results.push(`[${tool}]:
${resultText}`);

            console.error(`[toolChain]   ← ${resultText.length} chars`);
            if (resultText.length < 400) console.error(resultText);

        } catch (err) {
            console.error(`[toolChain]   ✗ Tool error: ${err.message}`);
            execState.recordToolCall(tool, args, `Tool error: ${err.message}`, stepsRun);
            results.push(`[${tool} ERROR]: ${err.message}`);
            anyFailed = true;
        }
    }

    const success = !anyFailed && stepsRun > 0;
    console.error(`[toolChain] Direct recovery done — ${stepsRun} steps, success=${success}`);
    return { results, success, stepsRun };
}

/**
 * Execute a named template's steps directly — zero LLM calls.
 *
 * @param {string}         templateName  — must match a TOOL_CHAIN_TEMPLATES[].name
 * @param {string}         project
 * @param {MCPClient}      mcpClient
 * @param {ExecutionState} execState
 * @param {object}         [costState]   — { llmCalls, totalChars } — not incremented here
 * @returns {{ results: string[], success: boolean, stepsRun: number }}
 */
export async function executeToolChain(templateName, project, mcpClient, execState, costState = null) {
    const template = TOOL_CHAIN_TEMPLATES.find(t => t.name === templateName);
    if (!template) {
        console.error(`[toolChain] Template "${templateName}" not found`);
        return { results: [], success: false, stepsRun: 0 };
    }

    console.error(`
[toolChain] ⚡ Executing template "${templateName}" directly (${template.steps.length} steps, 0 LLM calls)`);

    const results = [];
    let stepsRun  = 0;
    let anyFailed = false;

    for (const step of template.steps) {
        const toolCall = resolveStepToTool(step, project);

        if (!toolCall) {
            // Step requires LLM resolution — cannot execute directly; log and skip
            console.error(`[toolChain]   ⚠ Step "${step}" needs LLM — skipped in direct mode`);
            continue;
        }

        // Active ExecutionState gate: skip redundant reads
        if (toolCall.tool === "project_read_files" && Array.isArray(toolCall.args?.paths)) {
            const unread = toolCall.args.paths.filter(p => !execState.hasRead(p));
            if (unread.length === 0) {
                console.error(`[toolChain]   ⚡ Skipping already-read: ${toolCall.args.paths.join(", ")}`);
                continue;
            }
            toolCall.args.paths = unread;
        }

        console.error(`[toolChain]   → ${toolCall.tool}`);
        stepsRun++;

        try {
            assertToolAllowed(toolCall.tool);  // Bug 10 fix — hard block before dispatch
            const result    = await mcpClient.callTool(toolCall.tool, toolCall.args);
            const resultText = result?.content?.map(c => c.text || "").join("
").substring(0, 3000) || "";

            execState.recordToolCall(toolCall.tool, toolCall.args, resultText, stepsRun);
            results.push(`[${toolCall.tool}]:
${resultText}`);

            console.error(`[toolChain]   ← ${resultText.length} chars`);
            if (resultText.length < 400) console.error(resultText);

            // Stop chain early on severe failure
            const lastErr = execState.lastError();
            if (lastErr?.stepIndex === stepsRun && lastErr.type === "build_failure") {
                console.error(`[toolChain]   ✗ Build failure on step ${stepsRun} — stopping chain`);
                anyFailed = true;
                break;
            }

        } catch (err) {
            console.error(`[toolChain]   ✗ Tool error: ${err.message}`);
            execState.recordToolCall(toolCall.tool, toolCall.args, `Tool error: ${err.message}`, stepsRun);
            results.push(`[${toolCall.tool} ERROR]: ${err.message}`);
            anyFailed = true;
        }
    }

    const success = !anyFailed && stepsRun > 0;
    console.error(`[toolChain] Template "${templateName}" done — ${stepsRun} steps, success=${success}`);
    return { results, success, stepsRun };
}
