import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { scanProject }        from "./tools/scanProject.js";
import { readFiles }          from "./tools/readFiles.js";
import { applyChanges }       from "./tools/applyChanges.js";
import { searchProject }      from "./tools/projectSearch.js";
import { applyPatch }         from "./tools/projectPatch.js";
import { buildProject }       from "./tools/projectBuild.js";
import { projectFindSymbol }  from "./tools/projectFindSymbol.js";
import { projectIndex }       from "./tools/projectIndex.js";
import { runAutoFix }         from "./autoFixLoop/autoFixLoop.js";
import { getProject, listProjects } from "./core/projectRegistry.js";
import { buildDependencyGraph } from "./analysis/dependencyGraph.js";

const server = new Server(
    { name: "ai-dev-mcp", version: "9.0.0" },
    { capabilities: { tools: {} } }
);

// ─── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_scan",
            description: "Scan project file structure",
            inputSchema: {
                type: "object",
                properties: {
                    project:    { type: "string" },
                    extensions: { type: "array", items: { type: "string" } },
                    maxDepth:   { type: "number" }
                },
                required: ["project"]
            }
        },
        {
            name: "project_read_files",
            description: "Read one or more project files",
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
            description: "Write files to the project and git commit",
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
            name: "project_search",
            description: "Search code using ripgrep",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    query:   { type: "string" }
                },
                required: ["project", "query"]
            }
        },
        {
            name: "project_apply_patch",
            description: "Apply a git diff patch to the project",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    patch:   { type: "string" }
                },
                required: ["project", "patch"]
            }
        },
        {
            name: "project_build",
            description: "Run the project build command",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_build_and_fix",
            description: "Build and auto-fix compilation errors (up to 5 attempts)",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_index",
            description: "Build AST-based symbol index for the project",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    force:   { type: "boolean" }
                },
                required: ["project"]
            }
        },
        {
            name: "project_find_symbol",
            description: "Find classes or functions by name in the semantic index",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    name:    { type: "string" }
                },
                required: ["project", "name"]
            }
        },
        {
            name: "project_dependency_graph",
            description: "Analyse import/require dependency graph of the project",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_list",
            description: "List all configured projects",
            inputSchema: {
                type: "object",
                properties: {}
            }
        }
    ]
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    const args = req.params.arguments;

    console.error(`\n[mcp] Tool: ${tool} | Args: ${JSON.stringify(args)}`);

    try {
        switch (tool) {
            case "project_scan":             return scanProject(args);
            case "project_read_files":       return readFiles(args);
            case "project_apply_changes":    return applyChanges(args);
            case "project_search":           return searchProject(args);
            case "project_apply_patch":      return applyPatch(args);
            case "project_build":            return buildProject(args);
            case "project_index":            return projectIndex(args);
            case "project_find_symbol":      return projectFindSymbol(args);

            case "project_list": {
                const projects = listProjects();
                return { content: [{ type: "text", text: projects.join("\n") }] };
            }

            case "project_dependency_graph": {
                const root = getProject(args.project).root;
                const graph = buildDependencyGraph(root);
                return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
            }

            case "project_build_and_fix": {
                const result = await runAutoFix(args.project);
                return {
                    content: [{
                        type: "text",
                        text: result.success
                            ? `Build succeeded after ${result.attempts} attempt(s)`
                            : `Build failed after ${result.attempts} attempt(s)`
                    }]
                };
            }

            default:
                throw new Error(`Unknown tool: ${tool}`);
        }
    } catch (err) {
        console.error(`[mcp] Tool error: ${err.message}`);
        return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true
        };
    }
});

// ─── Start server ─────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
console.error("[mcp] Server ready (v9.0.0)");
