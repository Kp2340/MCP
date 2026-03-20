import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { scanProject } from "./tools/scanProject.js";
import { readFiles } from "./tools/readFiles.js";
import { applyChanges } from "./tools/applyChanges.js";
import { searchProject } from "./tools/projectSearch.js";
import { applyPatch } from "./tools/projectPatch.js";
import { buildProject } from "./tools/projectBuild.js";
import { projectFindSymbol } from "./tools/projectFindSymbol.js";
import { projectIndex } from "./tools/projectIndex.js";
import { projectStrReplace } from "./tools/projectStrReplace.js";
import { runAutoFix } from "./autoFixLoop/autoFixLoop.js";

import { getProject, listProjects } from "./core/projectRegistry.js";
import { buildDependencyGraph } from "./analysis/dependencyGraph.js";
import { queryCodebase } from "./vector/queryCodebase.js";
import { embed } from "./vector/embedder.js";

const server = new Server(
    { name: "ai-dev-mcp", version: "2.2.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_scan",
            description: "Scan project structure",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_read_files",
            description: "Read project files",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    paths: { type: "array", items: { type: "string" } }
                },
                required: ["project", "paths"]
            }
        },
        {
            name: "project_apply_changes",
            description: "Write files and commit",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    files: { type: "array" },
                    commitMessage: { type: "string" },
                    increment: { type: "boolean" }
                },
                required: ["project", "files", "commitMessage"]
            }
        },
        {
            name: "project_str_replace",
            description: "Apply targeted search-and-replace edits to files without rewriting the whole file. Safer and more token-efficient than project_apply_changes for small changes.",
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
            description: "Search code using ripgrep",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    query: { type: "string" }
                },
                required: ["project", "query"]
            }
        },
        {
            name: "project_apply_patch",
            description: "Apply git diff patch",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    patch: { type: "string" }
                },
                required: ["project", "patch"]
            }
        },
        {
            name: "project_build",
            description: "Run project build command",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_index",
            description: "Build semantic index of project",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_find_symbol",
            description: "Find symbol in semantic index",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    name: { type: "string" }
                },
                required: ["project", "name"]
            }
        },
        {
            name: "project_dependency_graph",
            description: "Analyze project dependency graph",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_build_and_fix",
            description: "Build project and auto-fix compilation errors",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"]
            }
        },
        {
            name: "project_semantic_search",
            description: "Search relevant code snippets using semantic meaning",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    query: { type: "string" }
                },
                required: ["project", "query"]
            }
        },
        {
            name: "project_list",
            description: "List all available projects registered in this MCP server",
            inputSchema: {
                type: "object",
                properties: {},
                required: []
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {

    const tool = req.params.name;
    const args = req.params.arguments;
    console.error("\n========== TOOL CALL ==========");
    console.error("Tool:", tool);
    console.error("Args:", args);
    console.error("================================");

    if (tool === "project_scan")           return scanProject(args);
    if (tool === "project_read_files")     return readFiles(args);
    if (tool === "project_apply_changes")  return applyChanges(args);
    if (tool === "project_str_replace")    return projectStrReplace(args);
    if (tool === "project_search")         return searchProject(args);
    if (tool === "project_apply_patch")    return applyPatch(args);
    if (tool === "project_build")          return buildProject(args);
    if (tool === "project_index")          return projectIndex(args);
    if (tool === "project_find_symbol")    return projectFindSymbol(args);

    if (tool === "project_list") {
        return {
            content: [{
                type: "text",
                text: JSON.stringify(listProjects(), null, 2)
            }]
        };
    }

    if (tool === "project_dependency_graph") {
        const projectRoot = getProject(args.project).root;
        const graph = buildDependencyGraph(projectRoot);
        return {
            content: [{ type: "text", text: JSON.stringify(graph, null, 2) }]
        };
    }

    if (tool === "project_build_and_fix") {
        await runAutoFix(args.project);
        return {
            content: [{ type: "text", text: "Build + auto-fix completed" }]
        };
    }

    if (tool === "project_semantic_search") {
        const embedding = await embed(args.query);
        const docs = await queryCodebase(embedding, args.project);
        return {
            content: [{ type: "text", text: docs.join("\n\n---\n\n") }]
        };
    }

    throw new Error("Unknown tool: " + tool);
});

await server.connect(new StdioServerTransport());
