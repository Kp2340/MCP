/**
 * src/agent/mcpClient.js  —  In-process MCP tool client (v2)
 *
 * Previous version spawned a child `node src/index.js` process for every agent
 * job. This doubled RAM usage (two full Node runtimes, two ChromaDB clients,
 * two embedder instances) and added ~30s of cold-start latency per job.
 *
 * This version calls the tool functions directly in-process — same Node.js
 * runtime, zero spawn overhead, ~50% less RAM per job.
 *
 * The public API is identical: callTool(name, args) returns the same
 * { content: [{ type, text }] } shape the old stdio client returned.
 */

import { scanProject }       from "../tools/scanProject.js";
import { readFiles }         from "../tools/readFiles.js";
import { applyChanges }      from "../tools/applyChanges.js";
import { searchProject }     from "../tools/projectSearch.js";
import { applyPatch }        from "../tools/projectPatch.js";
import { buildProject }      from "../tools/projectBuild.js";
import { projectFindSymbol } from "../tools/projectFindSymbol.js";
import { projectIndex }      from "../tools/projectIndex.js";
import { projectStrReplace } from "../tools/projectStrReplace.js";
import { analyzeProject }    from "../tools/staticAnalyzer.js";
import { runAutoFix }        from "../autoFixLoop/autoFixLoop.js";
import { testProject }       from "../tools/projectTest.js";
import { projectDiff }       from "../tools/projectDiff.js";
import { projectGitLog }     from "../tools/projectGitLog.js";
import { registerProject }   from "../tools/projectRegister.js";
import { listProjects, getProject } from "../core/projectRegistry.js";
import { buildDependencyGraph }     from "../analysis/dependencyGraph.js";
import { queryCodebase }            from "../vector/queryCodebase.js";
import { embed }                    from "../vector/embedder.js";
import { storeMemory, queryMemory } from "../vector/memory.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("mcp-client");

// Wrap a tool result so it always has the standard { content: [{ type, text }] } shape
function wrap(result) {
    if (!result) return { content: [{ type: "text", text: "" }] };
    if (result.content) return result;  // already shaped correctly
    return { content: [{ type: "text", text: String(result) }] };
}

export class MCPClient {

    /**
     * Call an MCP tool by name, in-process.
     * Returns { content: [{ type: "text", text: string }] }
     */
    async callTool(name, args = {}) {
        try {
            switch (name) {
                case "project_register":        return wrap(await registerProject(args));
                case "project_scan":            return wrap(await scanProject(args));
                case "project_read_files":      return wrap(await readFiles(args));
                case "project_apply_changes":   return wrap(await applyChanges(args));
                case "project_str_replace":     return wrap(await projectStrReplace(args));
                case "project_search":          return wrap(await searchProject(args));
                case "project_apply_patch":     return wrap(await applyPatch(args));
                case "project_build":           return wrap(await buildProject(args));
                case "project_index":           return wrap(await projectIndex(args));
                case "project_find_symbol":     return wrap(await projectFindSymbol(args));
                case "project_build_and_fix":   return wrap(await runAutoFix(args.project).then(r => ({
                    content: [{ type: "text", text: r.success
                        ? `Build fixed in ${r.attempts} attempt(s)`
                        : `Build failed after ${r.attempts} attempts` }]
                })));
                case "project_analyze":         return wrap(await analyzeProject(args));
                case "project_test":            return wrap(await testProject(args));
                case "project_diff":            return wrap(await projectDiff(args));
                case "project_git_log":         return wrap(await projectGitLog(args));
                case "project_list":            return { content: [{ type: "text",
                    text: listProjects().join("
") || "No projects registered." }] };

                case "project_dependency_graph": {
                    const proj  = getProject(args.project);
                    const graph = await buildDependencyGraph(proj.root);
                    return wrap({ content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] });
                }

                case "project_semantic_search": {
                    const embedding = await embed(args.query);
                    const results   = await queryCodebase(embedding, args.project, 8);
                    return wrap({ content: [{ type: "text", text: results.join("

---

") || "No results." }] });
                }

                case "project_memory_store": {
                    await storeMemory(args.project, args.text, args.tag || "general");
                    return wrap({ content: [{ type: "text", text: "Memory stored." }] });
                }

                case "project_memory_query": {
                    const result = await queryMemory(args.project, args.prompt, { returnStructured: false });
                    return wrap({ content: [{ type: "text", text: result || "No relevant memories found." }] });
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (err) {
            log.error(`callTool(${name}) error: ${err.message}`);
            // Return error as content so the agent can see and react to it
            return { content: [{ type: "text", text: `Tool error (${name}): ${err.message}` }], isError: true };
        }
    }
}
