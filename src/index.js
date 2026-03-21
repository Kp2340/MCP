/**
 * src/index.js — AI Dev MCP Server v5.1.0
 *
 * ONE command starts everything: node src/index.js
 *
 * Default mode (HTTP) — serves BOTH use cases simultaneously on one port:
 *
 *   USE CASE 1 — Agentic IDE (VS Code extension / IntelliJ plugin)
 *     POST /run          Submit a natural-language task → Qwen2.5-7B agent loop
 *     GET  /status/:id   Poll job result
 *     GET  /stream/:id   Live SSE progress stream
 *     GET  /jobs         List all jobs
 *     GET  /queue        Queue status
 *
 *   USE CASE 2 — MCP tool provider (Claude Desktop / Cursor / Windsurf / any MCP IDE)
 *     GET  /sse          MCP SSE endpoint — connect your IDE here
 *     POST /message      MCP tool calls routed to all 19 project tools
 *
 *   SHARED
 *     GET  /health       Health check (no auth)
 *
 * Optional: set TRANSPORT=stdio in .env to run as a stdio server instead.
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// ── HTTP layer imports ────────────────────────────────────────────────────────
import { attachMcpRoutes } from "./http/mcpRouter.js";
import { attachJobRoutes } from "./http/jobRoutes.js";
import { authMiddleware, ipAllowlistMiddleware, rateLimitMiddleware } from "./http/auth.js";
import { corsMiddleware }  from "./http/cors.js";

// ── Tool imports ──────────────────────────────────────────────────────────────
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
import { projectDiff }       from "./tools/projectDiff.js";
import { projectGitLog }     from "./tools/projectGitLog.js";
import { registerProject }   from "./tools/projectRegister.js";

// ── Core imports ──────────────────────────────────────────────────────────────
import { getProject, listProjects, listDynamicProjects } from "./core/projectRegistry.js";
import { buildDependencyGraph }     from "./analysis/dependencyGraph.js";
import { queryCodebase }            from "./vector/queryCodebase.js";
import { embed }                    from "./vector/embedder.js";
import { storeMemory, queryMemory } from "./vector/memory.js";
import { config }                   from "./core/config.js";
import { createLogger }             from "./core/logger.js";

const log = createLogger("server");

// ── MCP Server ────────────────────────────────────────────────────────────────
const mcpServer = new Server(
    { name: "ai-dev-mcp", version: "5.1.0" },
    { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_register",
            description: "Register a new project by name and path. Call this FIRST for any project not already known to the server. Auto-detects project type (React, Spring Boot, Django, Odoo, Go, etc.) and starts background indexing. After calling this, use the name in all other project_* tools.",
            inputSchema: {
                type: "object",
                properties: {
                    name:    { type: "string", description: "Friendly short name, e.g. 'odoo' or 'my-project'" },
                    path:    { type: "string", description: "Absolute path to the project root, e.g. 'C:/Projects/odoo-addons'" },
                    type:    { type: "string", description: "Optional type override. Auto-detected if omitted. Options: nextjs, react-vite, nodejs, spring-boot, django, odoo, python, go, rust, rails" },
                    persist: { type: "boolean", description: "If true, saves to projects.json so the project survives server restart" }
                },
                required: ["name", "path"]
            }
        },
        {
            name: "project_scan",
            description: "Scan project structure. The 'project' field accepts either a registered project name OR an absolute path to auto-register on the fly.",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_read_files",
            description: "Read project files",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    paths:   { type: "array", items: { type: "string" } }
                },
                required: ["project", "paths"]
            }
        },
        {
            name: "project_apply_changes",
            description: "Write full files and commit — use for new files only. Prefer project_str_replace for edits.",
            inputSchema: {
                type: "object",
                properties: {
                    project:       { type: "string" },
                    files:         { type: "array" },
                    commitMessage: { type: "string" },
                    increment:     { type: "boolean" }
                },
                required: ["project", "files", "commitMessage"]
            }
        },
        {
            name: "project_str_replace",
            description: "Apply targeted search-and-replace edits without rewriting whole files. Safer and more token-efficient.",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    edits: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                path:    { type: "string" },
                                search:  { type: "string" },
                                replace: { type: "string" }
                            },
                            required: ["path", "search", "replace"]
                        }
                    },
                    commitMessage: { type: "string" }
                },
                required: ["project", "edits", "commitMessage"]
            }
        },
        {
            name: "project_search",
            description: "Search code using ripgrep. Optional fileType filter (e.g. 'js', 'ts', 'java', 'py').",
            inputSchema: {
                type: "object",
                properties: {
                    project:  { type: "string" },
                    query:    { type: "string" },
                    fileType: { type: "string" }
                },
                required: ["project", "query"]
            }
        },
        {
            name: "project_apply_patch",
            description: "Apply git diff patch",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" }, patch: { type: "string" } },
                required: ["project", "patch"]
            }
        },
        {
            name: "project_build",
            description: "Run project build command",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_index",
            description: "Build semantic index of project (incremental)",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_find_symbol",
            description: "Find class/function/component by name. Returns file + line number.",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" }, name: { type: "string" } },
                required: ["project", "name"]
            }
        },
        {
            name: "project_dependency_graph",
            description: "Analyze project import dependency graph",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_build_and_fix",
            description: "Build project and auto-fix compilation errors",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_semantic_search",
            description: "Search code by semantic meaning using vector embeddings",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" }, query: { type: "string" } },
                required: ["project", "query"]
            }
        },
        {
            name: "project_analyze",
            description: "Static analysis — checks broken imports, syntax errors, TypeScript errors",
            inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] }
        },
        {
            name: "project_memory_store",
            description: "Store an architecture pattern or decision to long-term project memory",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    text:    { type: "string" },
                    tag:     { type: "string" }
                },
                required: ["project", "text"]
            }
        },
        {
            name: "project_memory_query",
            description: "Query long-term project memory for patterns relevant to a prompt",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" }, prompt: { type: "string" } },
                required: ["project", "prompt"]
            }
        },
        // project_list is only exposed when EXPOSE_PROJECT_LIST=true in .env
        // Default is false — hides all project names from connected AI IDEs
        ...(config.EXPOSE_PROJECT_LIST ? [{
            name: "project_list",
            description: "List all registered projects",
            inputSchema: { type: "object", properties: {}, required: [] }
        }] : []),
        {
            name: "project_diff",
            description: "Show uncommitted git changes as unified diff",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    staged:  { type: "boolean" }
                },
                required: ["project"]
            }
        },
        {
            name: "project_git_log",
            description: "Show recent git commit history",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    count:   { type: "number" }
                },
                required: ["project"]
            }
        }
    ]
}));

// ── Tool router ───────────────────────────────────────────────────────────────
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    const args = req.params.arguments;

    log.info(`Tool call: ${tool} | args: ${JSON.stringify(args).substring(0, 150)}`);

    if (tool === "project_register")      return registerProject(args);
    if (tool === "project_scan")           return scanProject(args);
    if (tool === "project_read_files")     return readFiles(args);
    if (tool === "project_apply_changes")  return applyChanges(args);
    if (tool === "project_str_replace")    return projectStrReplace(args);
    if (tool === "project_search")         return searchProject(args);
    if (tool === "project_apply_patch")    return applyPatch(args);
    if (tool === "project_build")          return buildProject(args);
    if (tool === "project_index")          return projectIndex(args);
    if (tool === "project_find_symbol")    return projectFindSymbol(args);
    if (tool === "project_analyze")        return analyzeProject(args);
    if (tool === "project_diff")           return projectDiff(args);
    if (tool === "project_git_log")        return projectGitLog(args);

    if (tool === "project_list") {
        if (!config.EXPOSE_PROJECT_LIST) {
            return { content: [{ type: "text", text: "project_list is disabled. Set EXPOSE_PROJECT_LIST=true in .env to enable." }] };
        }
        const all     = listProjects();
        const dynamic = listDynamicProjects();
        return { content: [{ type: "text", text: JSON.stringify({ projects: all, dynamic }, null, 2) }] };
    }
    if (tool === "project_dependency_graph") {
        const root  = getProject(args.project).root;
        const graph = buildDependencyGraph(root);
        return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
    }
    if (tool === "project_build_and_fix") {
        await runAutoFix(args.project);
        return { content: [{ type: "text", text: "Build + auto-fix completed" }] };
    }
    if (tool === "project_semantic_search") {
        const embedding = await embed(args.query);
        const docs      = await queryCodebase(embedding, args.project);
        return { content: [{ type: "text", text: docs.join("\n\n---\n\n") }] };
    }
    if (tool === "project_memory_store") {
        await storeMemory(args.project, args.text, args.tag || "general");
        return { content: [{ type: "text", text: "Memory stored" }] };
    }
    if (tool === "project_memory_query") {
        const memory = await queryMemory(args.project, args.prompt);
        return { content: [{ type: "text", text: memory || "No relevant memory found" }] };
    }

    throw new Error(`Unknown tool: ${tool}`);
});

// ── Transport startup ─────────────────────────────────────────────────────────
if (config.TRANSPORT === "stdio") {
    log.info("Starting in STDIO mode (MCP over stdin/stdout)");
    await mcpServer.connect(new StdioServerTransport());

} else {
    const app = express();
    app.use(corsMiddleware);
    app.use(express.json());
    app.use(authMiddleware);

    app.get("/health", (_req, res) => res.json({
        status:    "ok",
        version:   "5.1.0",
        transport: "http",
        uptime:    Math.floor(process.uptime())
    }));

    attachMcpRoutes(app, mcpServer);
    attachJobRoutes(app);

    app.listen(config.PORT, () => {
        log.info("═".repeat(51));
        log.info(`  AI Dev MCP Server v5.1.0  —  port ${config.PORT}`);
        log.info("═".repeat(51));
        log.info("  Use case 1 — Agentic IDE:");
        log.info(`    POST ${config.BASE_URL}/run           submit task`);
        log.info(`    GET  ${config.BASE_URL}/stream/:id    live progress`);
        log.info(`    GET  ${config.BASE_URL}/status/:id    poll result`);
        log.info("  Use case 2 — MCP tool provider:");
        log.info(`    GET  ${config.BASE_URL}/sse           IDE connects here`);
        log.info(`    POST ${config.BASE_URL}/message       tool call endpoint`);
        log.info("  Auth: x-api-key header required" + (config.API_KEY ? " ✓" : " — DISABLED (set API_KEY)"));
        log.info("═".repeat(51));
    });
}
