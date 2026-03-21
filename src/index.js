/**
 * src/index.js — AI Dev MCP Server v5.0.0
 *
 * Dual-transport server:
 *   TRANSPORT=http   → HTTP + SSE  (multi-IDE, production)
 *   TRANSPORT=stdio  → Stdio        (Claude Desktop, local)
 *
 * HTTP mode exposes:
 *   GET  /sse          MCP SSE endpoint (IDE connects here)
 *   POST /message      MCP tool calls
 *   POST /run          Enqueue agent job
 *   GET  /status/:id   Job status
 *   GET  /stream/:id   Live SSE job updates
 *   GET  /jobs         List jobs
 *   GET  /queue        Queue status
 *   GET  /health       Health check
 */

import { Server }             from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

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

// ── Core imports ──────────────────────────────────────────────────────────────
import { getProject, listProjects } from "./core/projectRegistry.js";
import { buildDependencyGraph }     from "./analysis/dependencyGraph.js";
import { queryCodebase }            from "./vector/queryCodebase.js";
import { embed }                    from "./vector/embedder.js";
import { storeMemory, queryMemory } from "./vector/memory.js";
import { config }                   from "./core/config.js";
import { createLogger }             from "./core/logger.js";

const log = createLogger("server");

// ── MCP Server ────────────────────────────────────────────────────────────────
const mcpServer = new Server(
    { name: "ai-dev-mcp", version: "5.0.0" },
    { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_scan",
            description: "Scan project structure",
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
            description: "Search code using ripgrep. Optional fileType filter (e.g. 'js', 'ts', 'java').",
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
        {
            name: "project_list",
            description: "List all registered projects",
            inputSchema: { type: "object", properties: {}, required: [] }
        },
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
        return { content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }] };
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

// ── Transport selection ───────────────────────────────────────────────────────
if (config.TRANSPORT === "stdio") {
    // ── Stdio mode: Claude Desktop / direct local use ─────────────────────────
    log.info("Starting in STDIO transport mode");
    await mcpServer.connect(new StdioServerTransport());

} else {
    // ── HTTP + SSE mode: multi-IDE, remote access ─────────────────────────────
    const { default: express }  = await import("express");
    const { corsMiddleware }     = await import("./http/cors.js");
    const { authMiddleware }     = await import("./http/auth.js");
    const { attachMcpRoutes }   = await import("./http/mcpRouter.js");
    const { attachJobRoutes }   = await import("./http/jobRoutes.js");

    const app = express();

    // Trust proxy headers (Cloudflare / ngrok set X-Forwarded-*)
    app.set("trust proxy", 1);

    // ── Middleware stack ──────────────────────────────────────────────────────
    app.use(corsMiddleware);                      // CORS + proxy headers
    app.use(express.json({ limit: "2mb" }));      // parse JSON bodies
    app.use(authMiddleware);                      // API key validation

    // ── Request logger ────────────────────────────────────────────────────────
    app.use((req, _res, next) => {
        const ip = req.headers["x-forwarded-for"] || req.ip;
        log.info(`${req.method} ${req.path} | ip=${ip}`);
        next();
    });

    // ── Routes ────────────────────────────────────────────────────────────────
    attachMcpRoutes(app, mcpServer);  // /sse  /message
    attachJobRoutes(app);             // /run  /status/:id  /stream/:id  /jobs  /queue  /health

    // ── 404 handler ───────────────────────────────────────────────────────────
    app.use((req, res) => {
        res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
    });

    // ── Error handler ─────────────────────────────────────────────────────────
    app.use((err, _req, res, _next) => {
        log.error("Unhandled error:", err.message);
        res.status(500).json({ error: err.message || "Internal server error" });
    });

    // ── Start ─────────────────────────────────────────────────────────────────
    app.listen(config.PORT, () => {
        log.info(`AI Dev MCP Server v5.0.0 running`);
        log.info(`Base URL:  ${config.BASE_URL}`);
        log.info(`SSE:       ${config.BASE_URL}/sse`);
        log.info(`Message:   ${config.BASE_URL}/message`);
        log.info(`Run job:   ${config.BASE_URL}/run`);
        log.info(`Health:    ${config.BASE_URL}/health`);
        log.info(`Auth:      ${config.API_KEY ? "ENABLED" : "DISABLED (set API_KEY env var)"}`);
    });
}
