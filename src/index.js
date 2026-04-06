/**
 * src/index.js — AI Dev MCP Server v5.4.0
 *
 * ONE command starts everything: node src/index.js
 *
 * USE CASE 1 — Agentic IDE (VS Code / IntelliJ plugin)
 *   POST /run          Submit a natural-language task → Qwen2.5-7B agent loop
 *   GET  /status/:id   Poll job result
 *   GET  /stream/:id   Live SSE progress stream
 *   GET  /jobs         List all jobs
 *   GET  /queue        Queue status
 *   GET  /diff/:id     Git diff of completed job
 *   POST /revert/:id   Undo agent changes (safe by default)
 *
 * USE CASE 2 — MCP tool provider (Claude Desktop / Cursor / Windsurf)
 *   POST /mcp          Streamable HTTP (modern clients)
 *   GET  /sse          Legacy SSE transport
 *   POST /message      Legacy SSE messages
 *
 * WEB UI
 *   GET  /ui           Browser dashboard — jobs, diffs, health, submit tasks
 *
 * SHARED
 *   GET  /health       Health check (no auth required)
 *
 * Optional: set TRANSPORT=stdio in .env for stdio-only mode.
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import http    from "http";

// ── HTTP layer ─────────────────────────────────────────────────────────────────
import { startHttpServer }    from "./http/startHttpServer.js";
import { attachMcpRoutes }    from "./http/mcpRouter.js";

// ── Tools ────────────────────────────────────────────────────────────────────
import { scanProject }       from "./tools/scanProject.js";
import { readFiles }         from "./tools/readFiles.js";
import { applyChanges }      from "./tools/applyChanges.js";
import { searchProject }     from "./tools/projectSearch.js";
import { applyPatch }        from "./tools/projectPatch.js";
import { buildProject }      from "./tools/projectBuild.js";
import { projectFindSymbol } from "./tools/projectFindSymbol.js";
import { projectIndex }      from "./tools/projectIndex.js";
import { projectStrReplace } from "./tools/projectStrReplace.js";
import { analyzeProject }    from "./tools/staticAnalyzer.js";
import { runAutoFix }        from "./autoFixLoop/autoFixLoop.js";
import { testProject }       from "./tools/projectTest.js";
import { projectDiff }       from "./tools/projectDiff.js";
import { projectGitLog }     from "./tools/projectGitLog.js";
import { registerProject }         from "./tools/projectRegister.js";
import { registerAstReplaceTools } from "./tools/astReplace.js";
import { dispatchAstReplace }      from "./tools/astReplaceDispatch.js";

// ── Core ──────────────────────────────────────────────────────────────────────
import { getProject, listProjects, getProjectForUser } from "./core/projectRegistry.js";
import { buildDependencyGraph }     from "./analysis/dependencyGraph.js";
import { queryCodebase }            from "./vector/queryCodebase.js";
import { embed }                    from "./vector/embedder.js";
import { storeMemory, queryMemory } from "./vector/memory.js";
import { config }                   from "./core/config.js";
import { createLogger }             from "./core/logger.js";
import { logToolCall, stats as toolStats, recentCalls } from "./core/toolLogger.js";
import {corsMiddleware} from "./http/cors.js";
import {authMiddleware, ipAllowlistMiddleware, rateLimitMiddleware} from "./http/auth.js";
import {attachHealthRoutes} from "./http/healthRoutes.js";
import {attachUiRoutes} from "./http/uiRoutes.js";
import {attachJobRoutes} from "./http/jobRoutes.js";
import {runStartupChecks} from "./http/startupChecks.js";

const log = createLogger("server");

// ───────────────────────────────────────────────────────────────────────
// MCP Server
// ───────────────────────────────────────────────────────────────────────
const mcpServer = new Server(
    { name: "ai-dev-mcp", version: "5.4.0" },
    { capabilities: { tools: {}, prompts: {} } }
);

// ───────────────────────────────────────────────────────────────────────
// Tool definitions (20 tools)
// ───────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────
// Tool call logger helper — wraps every tool dispatch with timing + identity
// ───────────────────────────────────────────────────────────────────────
/**
 * Extract a caller identifier from MCP request metadata.
 * Falls back through: session ID → client ID → "mcp-client".
 */
function getCallerFromRequest(request) {
    return request?._meta?.sessionId
        || request?._meta?.clientId
        || request?.params?._meta?.sessionId
        || "mcp-client";
}

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_register",
            description: "Register a new project by name and path. Call this FIRST for any project not already known to the server. Auto-detects project type (React, Spring Boot, Django, Odoo, Go, etc.) and starts background indexing.",
            inputSchema: { type: "object", properties: {
                name:    { type: "string" },
                path:    { type: "string" },
                type:    { type: "string" },
                persist: { type: "boolean" }
            }, required: ["name", "path"] }
        },
        {
            name: "project_scan",
            description: "Scan project structure. Accepts a registered project name OR an absolute path to auto-register on the fly.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_read_files",
            description: "Read project files. Always re-read a file after modifying it — the content changes.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                paths:   { type: "array", items: { type: "string" } }
            }, required: ["project", "paths"] }
        },
        {
            name: "project_apply_changes",
            description: "Write full files and commit. Use for NEW files only. For edits, always prefer project_str_replace.",
            inputSchema: { type: "object", properties: {
                project:       { type: "string" },
                files:         { type: "array" },
                commitMessage: { type: "string" },
                increment:     { type: "boolean" }
            }, required: ["project", "files", "commitMessage"] }
        },
        {
            name: "project_str_replace",
            description: "Apply targeted search-and-replace edits. IMPORTANT: the 'search' string must be copied VERBATIM from the file's CURRENT content. Always call project_read_files first if the file was recently modified. The search string must appear EXACTLY ONCE in the file.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                edits: { type: "array", items: { type: "object", properties: {
                    path:    { type: "string" },
                    search:  { type: "string" },
                    replace: { type: "string" }
                }, required: ["path", "search", "replace"] } },
                commitMessage: { type: "string" }
            }, required: ["project", "edits", "commitMessage"] }
        },
        {
            name: "project_search",
            description: "Search code using ripgrep. Optional fileType filter (e.g. 'js', 'ts', 'java', 'py').",
            inputSchema: { type: "object", properties: {
                project:  { type: "string" },
                query:    { type: "string" },
                fileType: { type: "string" }
            }, required: ["project", "query"] }
        },
        {
            name: "project_apply_patch",
            description: "Apply a git unified diff patch to the project.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                patch:   { type: "string" }
            }, required: ["project", "patch"] }
        },
        {
            name: "project_build",
            description: "Run the project build command.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_index",
            description: "Build or refresh the semantic vector index for the project (incremental).",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_find_symbol",
            description: "Find a class, function, or component by name. Returns file path + line number.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                name:    { type: "string" }
            }, required: ["project", "name"] }
        },
        {
            name: "project_dependency_graph",
            description: "Analyze the project's import dependency graph.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_build_and_fix",
            description: "Build the project and auto-fix compilation errors (up to 5 attempts).",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_semantic_search",
            description: "Search code by semantic meaning using vector embeddings.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                query:   { type: "string" }
            }, required: ["project", "query"] }
        },
        {
            name: "project_analyze",
            description: "Static analysis — checks broken imports, syntax errors, TypeScript errors. Run this BEFORE modifying files.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_memory_store",
            description: "Store an architecture pattern or decision to long-term project memory.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                text:    { type: "string" },
                tag:     { type: "string" }
            }, required: ["project", "text"] }
        },
        {
            name: "project_memory_query",
            description: "Query long-term project memory for patterns relevant to a prompt.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                prompt:  { type: "string" }
            }, required: ["project", "prompt"] }
        },
        ...(config.EXPOSE_PROJECT_LIST ? [{
            name: "project_list",
            description: "List all registered projects.",
            inputSchema: { type: "object", properties: {}, required: [] }
        }] : []),
        {
            name: "project_diff",
            description: "Show uncommitted git changes as a unified diff.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                staged:  { type: "boolean" }
            }, required: ["project"] }
        },
        {
            name: "project_git_log",
            description: "Show recent git commit history.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                count:   { type: "number" }
            }, required: ["project"] }
        },
        {
            name: "project_rename_symbol",
            description: "Rename ALL whole-word occurrences of a symbol in one file. Safer than str_replace for renames — matches every occurrence and respects identifier boundaries (won't corrupt substrings). Supports dry-run preview before writing.",
            inputSchema: { type: "object", properties: {
                project: { type: "string" },
                path:    { type: "string", description: "Relative file path, e.g. src/utils/auth.js" },
                oldName: { type: "string", description: "Identifier to rename (exact, case-sensitive)" },
                newName: { type: "string", description: "Replacement identifier" },
                dryRun:  { type: "boolean", description: "Preview without writing (default: false)" },
                backup:  { type: "boolean", description: "Write .bak before editing (default: false)" }
            }, required: ["project", "path", "oldName", "newName"] }
        },
        {
            name: "project_rename_symbol_all",
            description: "Rename ALL whole-word occurrences of a symbol across every source file in the project. Use for global identifier renames (function, class, constant). Always run project_analyze after.",
            inputSchema: { type: "object", properties: {
                project:    { type: "string" },
                oldName:    { type: "string", description: "Identifier to rename" },
                newName:    { type: "string", description: "Replacement identifier" },
                extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: all indexable)" },
                dryRun:     { type: "boolean", description: "Preview only, no writes (default: false)" }
            }, required: ["project", "oldName", "newName"] }
        },
        {
            name: "project_test",
            description: "Run the project test suite (npm test, vitest, jest, pytest, mvn test, go test, etc.) and return pass/fail results.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        }
    ]
}));

// ───────────────────────────────────────────────────────────────────────
// MCP Prompts — slash-commands in Claude Desktop / Cursor
// ───────────────────────────────────────────────────────────────────────
const PROMPTS = [
    {
        name: "fix-build",
        description: "Fix all build errors in the project",
        arguments: [{ name: "project", description: "Project name", required: true }]
    },
    {
        name: "add-api",
        description: "Add a new REST API endpoint",
        arguments: [
            { name: "project",     description: "Project name",        required: true },
            { name: "description", description: "What the endpoint does", required: true }
        ]
    },
    {
        name: "add-tests",
        description: "Write unit tests for a file or function",
        arguments: [
            { name: "project", description: "Project name", required: true },
            { name: "target",  description: "File or function name", required: true }
        ]
    },
    {
        name: "explain-file",
        description: "Explain what a file does and how it works",
        arguments: [
            { name: "project", description: "Project name",  required: true },
            { name: "file",    description: "Relative file path", required: true }
        ]
    },
    {
        name: "refactor",
        description: "Refactor code for clarity and maintainability",
        arguments: [
            { name: "project", description: "Project name",      required: true },
            { name: "target",  description: "File or function",   required: true }
        ]
    },
    {
        name: "add-ui-component",
        description: "Create a new React/UI component",
        arguments: [
            { name: "project",     description: "Project name",        required: true },
            { name: "component",   description: "Component name",       required: true },
            { name: "description", description: "What it should do",    required: false }
        ]
    }
];

mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

mcpServer.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const project = args.project || "<project>";

    const templates = {
        "fix-build": {
            description: "Fix all build errors",
            messages: [{ role: "user", content: { type: "text",
                text: `Fix all build errors in the project: ${project}

Steps:
1. Run project_analyze to find issues
2. Read the files with errors
3. Apply targeted fixes with project_str_replace
4. Run project_build_and_fix to verify` } }]
        },
        "add-api": {
            description: "Add a new API endpoint",
            messages: [{ role: "user", content: { type: "text",
                text: `Add a new API endpoint to project: ${project}

Description: ${args.description || "<describe the endpoint>"}

Steps:
1. Find the relevant controller/router file
2. Read it
3. Add the new endpoint using project_str_replace
4. Run project_analyze then project_build_and_fix` } }]
        },
        "add-tests": {
            description: "Write unit tests",
            messages: [{ role: "user", content: { type: "text",
                text: `Write unit tests for project: ${project}
Target: ${args.target || "<file or function>"}

Steps:
1. Find and read the target file
2. Find an existing test file for reference
3. Create the new test file with project_apply_changes
4. Run project_test to verify` } }]
        },
        "explain-file": {
            description: "Explain a file",
            messages: [{ role: "user", content: { type: "text",
                text: `Explain the file in project: ${project}
File: ${args.file || "<file path>"}

Steps:
1. Read the file with project_read_files
2. Search for related files with project_search
3. Explain its purpose, structure, and key functions` } }]
        },
        "refactor": {
            description: "Refactor code",
            messages: [{ role: "user", content: { type: "text",
                text: `Refactor the following in project: ${project}
Target: ${args.target || "<file or function>"}

Steps:
1. Run project_analyze
2. Read the target file
3. Apply improvements with project_str_replace (one change at a time)
4. Run project_build_and_fix` } }]
        },
        "add-ui-component": {
            description: "Create a UI component",
            messages: [{ role: "user", content: { type: "text",
                text: `Create a new UI component in project: ${project}
Name: ${args.component || "<ComponentName>"}
Description: ${args.description || ""}

Steps:
1. Scan project to find the components folder
2. Read a similar existing component for reference
3. Create the new component with project_apply_changes
4. Run project_analyze then project_build_and_fix` } }]
        }
    };

    const tpl = templates[name];
    if (!tpl) throw new Error(`Unknown prompt: ${name}`);
    return tpl;
});

// ───────────────────────────────────────────────────────────────────────
// Tool router
// ───────────────────────────────────────────────────────────────────────
// ── CallToolRequestSchema ───────────────────────────────────────────────────────────────────────
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    // Helper: wrap any thrown error as a tool error response
    async function run(fn) {
        try {
            return await fn();
        } catch (err) {
            log.error(`Tool error [${name}]:`, err.message);
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }

    switch (name) {
        case "project_register":        return run(() => registerProject(args));
        case "project_scan":            return run(() => scanProject(args));
        case "project_read_files":      return run(() => readFiles(args));
        case "project_apply_changes":   return run(() => applyChanges(args));
        case "project_str_replace":     return run(() => projectStrReplace(args));
        case "project_search":          return run(() => searchProject(args));
        case "project_apply_patch":     return run(() => applyPatch(args));
        case "project_build":           return run(() => buildProject(args));
        case "project_index":           return run(() => projectIndex(args));
        case "project_find_symbol":     return run(() => projectFindSymbol(args));
        case "project_build_and_fix":   return run(() => runAutoFix(args.project).then(r => ({ content: [{ type: "text", text: r.success ? `Build fixed in ${r.attempts} attempt(s)` : `Build failed after ${r.attempts} attempts` }] })));
        case "project_analyze":         return run(() => analyzeProject(args));
        case "project_diff":            return run(() => projectDiff(args));
        case "project_git_log":         return run(() => projectGitLog(args));
        case "project_test":            return run(() => testProject(args));
        case "project_list":            return run(() => ({ content: [{ type: "text", text: listProjects().join("") || "No projects registered." }] }));

        case "project_dependency_graph": return run(async () => {
            const proj = getProject(args.project);
            const graph = await buildDependencyGraph(proj.root);
            return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
        });

        case "project_semantic_search": return run(async () => {
            const embedding = await embed(args.query);
            const results   = await queryCodebase(embedding, args.project, 8);
            return { content: [{ type: "text", text: results.join("") || "No results found." }] };
        });

        case "project_memory_store": return run(async () => {
            await storeMemory(args.project, args.text, args.tag || "general");
            return { content: [{ type: "text", text: "Memory stored." }] };
        });

        case "project_memory_query": return run(async () => {
            const result = await queryMemory(args.project, args.prompt, { returnStructured: false });
            return { content: [{ type: "text", text: result || "No relevant memories found." }] };
        });

        default:
            return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
});

// ───────────────────────────────────────────────────────────────────────
// Transport + HTTP startup
// ───────────────────────────────────────────────────────────────────────
if (config.TRANSPORT === "stdio") {
    // Pure stdio mode — for Claude Desktop / Cursor / Windsurf local config
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    log.info("AI Dev MCP running in stdio mode");

} else {
    // HTTP mode — serves everything on one port
    const app = express();

    app.use(corsMiddleware);
    app.use(express.json({ limit: "10mb" }));
    app.use(ipAllowlistMiddleware);
    app.use(authMiddleware);

    // Health + UI (no auth — must come before authMiddleware applies to routes)
    attachHealthRoutes(app);
    attachUiRoutes(app);

    // /run rate-limit (per-user, only on the agent submission endpoint)
    app.use("/run", rateLimitMiddleware);

    // MCP tool routes (Streamable HTTP + Legacy SSE)
    // Claude MCP discovery endpoints

    app.get("/.well-known/oauth-protected-resource", (req, res) => {
        res.json({
            resource: "https://mcp.decorom.in"
        });
    });

    app.get("/.well-known/oauth-authorization-server", (req, res) => {
        res.json({
            issuer: "https://mcp.decorom.in",
            authorization_endpoint: "",
            token_endpoint: "",
            registration_endpoint: "https://mcp.decorom.in/register"
        });
    });

    app.post("/register", (req, res) => {
        res.json({
            client_id: "anonymous",
            token: "none"
        });
    });
    attachMcpRoutes(app, mcpServer);

    // Agent job routes
    attachJobRoutes(app);

    runStartupChecks();

    const port = config.PORT;
    app.listen(port, () => {
        log.info(`AI Dev MCP v5.3.0 listening on port ${port}`);
        log.info(`  MCP (Streamable HTTP): POST http://localhost:${port}/mcp`);
        log.info(`  MCP (Legacy SSE):      GET  http://localhost:${port}/sse`);
        log.info(`  Agent:                 POST http://localhost:${port}/run`);
        log.info(`  Web UI:                GET  http://localhost:${port}/ui`);
        log.info(`  Health:                GET  http://localhost:${port}/health`);
    });
}
