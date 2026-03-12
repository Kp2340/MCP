import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { scanProject } from "./projectScanner.js";
import { getProject } from "./projectRegistry.js";
import { validateChangeRequest } from "./validator.js";
import { applyFileChanges } from "./fileManager.js";
import { createBranch, commitChanges } from "./gitManager.js";

import fs from "fs";
import path from "path";

const server = new Server(
    { name: "ai-dev-mcp", version: "6.0.0" },
    { capabilities: { tools: {} } }
);

/* ===================================================
   LIST TOOLS
=================================================== */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "project_scan",
            description: "Scan project structure (returns file tree only, no content)",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    extensions: {
                        type: "array",
                        items: { type: "string" }
                    },
                    maxDepth: { type: "number" }
                },
                required: ["project"]
            }
        },
        {
            name: "project_read_files",
            description: "Read specific files safely from project",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    paths: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                required: ["project", "paths"]
            }
        },
        {
            name: "project_apply_changes",
            description: "Apply file modifications in selected project and commit",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    files: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                path: { type: "string" },
                                content: { type: "string" }
                            },
                            required: ["path", "content"]
                        }
                    },
                    commitMessage: { type: "string" }
                },
                required: ["project", "files", "commitMessage"]
            }
        }
    ]
}));

/* ===================================================
   TOOL EXECUTION
=================================================== */
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;

    /* ===========================
       PROJECT SCAN
    =========================== */
    if (toolName === "project_scan") {
        const { project, extensions = [], maxDepth = 5 } =
            req.params.arguments;

        const projectConfig = getProject(project);
        const projectRoot = projectConfig.root;

        const result = scanProject(projectRoot, extensions, maxDepth);

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }
            ]
        };
    }

    /* ===========================
       PROJECT READ FILES
    =========================== */
    if (toolName === "project_read_files") {
        const { project, paths } = req.params.arguments;

        const projectConfig = getProject(project);
        const projectRoot = path.resolve(projectConfig.root);

        const results = [];

        for (const relativePath of paths) {
            if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
                throw new Error("Invalid file path");
            }

            const fullPath = path.resolve(projectRoot, relativePath);

            if (!fullPath.startsWith(projectRoot + path.sep)) {
                throw new Error("Path escapes project root");
            }

            if (!fs.existsSync(fullPath)) {
                results.push({
                    path: relativePath,
                    error: "File not found"
                });
                continue;
            }

            let content = fs.readFileSync(fullPath, "utf-8");

            // Safety limit
            if (content.length > 12000) {
                content =
                    content.substring(0, 12000) +
                    "\n\n--- FILE TRUNCATED ---";
            }

            results.push({
                path: relativePath,
                content
            });
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(results, null, 2)
                }
            ]
        };
    }

    /* ===========================
       PROJECT APPLY CHANGES
    =========================== */
    if (toolName === "project_apply_changes") {
        const { project, files, commitMessage } =
            req.params.arguments;

        const projectConfig = getProject(project);
        const projectRoot = projectConfig.root;

        validateChangeRequest(files, projectRoot);

        const branch = createBranch(projectRoot);

        const result = applyFileChanges(files, projectRoot);

        commitChanges(commitMessage, projectRoot);

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Project: ${project}\n` +
                        `Branch: ${branch}\n\n` +
                        result
                }
            ]
        };
    }

    throw new Error("Unknown tool: " + toolName);
});

await server.connect(new StdioServerTransport());