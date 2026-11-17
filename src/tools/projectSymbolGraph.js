/**
 * project_symbol_graph — MCP tool
 *
 * Exposes the symbol graph to Claude so it can answer questions like:
 *   "Which files will break if I change this function?"
 *   "Where is this symbol defined?"
 *   "What are the most central files in this project?"
 *
 * Args:
 *   project  string   — project name
 *   query    string   — one of: "summary" | "dependents:<file>" | "find:<symbolName>"
 *
 * Examples:
 *   { project: "jsv", query: "summary" }
 *   { project: "jsv", query: "dependents:src/utils/auth.js" }
 *   { project: "jsv", query: "find:LoginForm" }
 */

import { buildSymbolGraph, findDependents, findSymbolDefinition, getGraphSummary } from "../analysis/symbolGraph.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("symbol-graph-tool");

export function projectSymbolGraph({ project, query = "summary" }) {
    if (!project) throw new Error("project is required");

    try {
        // summary — overview of the graph
        if (query === "summary" || !query) {
            const summary = getGraphSummary(project);
            return { content: [{ type: "text", text: summary }] };
        }

        // dependents:<file> — what will break if this file changes
        if (query.startsWith("dependents:")) {
            const filePath   = query.slice("dependents:".length).trim();
            const dependents = findDependents(project, filePath);
            const text = dependents.length > 0
                ? `Files that import "${filePath}" (will be affected by changes):\n${dependents.map(f => `  - ${f}`).join("\n")}`
                : `No files import "${filePath}" — changes are isolated.`;
            return { content: [{ type: "text", text }] };
        }

        // find:<symbol> — locate a symbol definition
        if (query.startsWith("find:")) {
            const symbolName = query.slice("find:".length).trim();
            const node       = findSymbolDefinition(project, symbolName);
            const text = node
                ? `Symbol "${symbolName}" defined in: ${node.file} (line ${node.line}, type: ${node.type})`
                : `Symbol "${symbolName}" not found in the symbol graph. Try project_search for a broader search.`;
            return { content: [{ type: "text", text }] };
        }

        return { content: [{ type: "text", text: `Unknown query format: "${query}". Use: summary | dependents:<file> | find:<symbol>` }] };

    } catch (err) {
        log.error(`projectSymbolGraph error: ${err.message}`);
        return { content: [{ type: "text", text: `Symbol graph error: ${err.message}` }] };
    }
}
