/**
 * project_register — Explicitly register a project by name + path.
 *
 * This is the primary tool for use case 1 (agentic IDE) and use case 2 (MCP).
 * It must be called before any other tool when the project is not in projects.json.
 *
 * After registration:
 *   - All other tools accept the project name normally
 *   - A background vector index is triggered automatically
 *   - Optionally persists to projects.json (persist: true)
 *
 * The tool also handles the case where the IDE passes the workspace path
 * directly as the project field — in that case registration is implicit
 * (projectRegistry.getProject handles it), but this tool makes it explicit
 * and allows giving the project a friendly short name.
 *
 * Args:
 *   name      string   friendly project name (used in all subsequent calls)
 *   path      string   absolute path to project root
 *   type      string   optional override (auto-detected if omitted)
 *   persist   boolean  if true, write to projects.json so it survives restart
 */

import { registerDynamicProject, saveProject } from "../core/projectRegistry.js";
import { indexProject }                         from "../vector/runIndexCore.js";
import { createLogger }                         from "../core/logger.js";

const log = createLogger("project-register");

export async function registerProject({ name, path: rootPath, type, persist = false }) {
    if (!name || typeof name !== "string") {
        throw new Error("name is required");
    }
    if (!rootPath || typeof rootPath !== "string") {
        throw new Error("path is required — provide the absolute path to the project root");
    }

    const config = registerDynamicProject(name, rootPath, { type });

    if (persist) {
        saveProject(name);
    }

    // Trigger background index — don't await, let it run async
    // so the registration response is instant.
    // Index when: indexExtensions is empty (means "all files") OR contains a known code ext.
    const CODE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".py", ".go", ".rb", ".rs"];
    const exts = config.indexExtensions || [];
    const shouldIndex = exts.length === 0   // empty = index everything
        || CODE_EXTENSIONS.some(ext => exts.includes(ext));

    if (shouldIndex) {
        log.info(`Triggering background index for "${name}"...`);
        indexProject(config.root, name).then(() => {
            log.info(`Background index complete for "${name}"`);
        }).catch(err => {
            log.warn(`Background index failed for "${name}": ${err.message}`);
        });
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                registered: true,
                name,
                root:         config.root,
                type:         config.type,
                buildCommand: config.buildCommand,
                branchPrefix: config.branchPrefix,
                indexing:     shouldIndex,
                persisted:    persist,
                message:      `Project "${name}" registered. You can now use all project_* tools with project: "${name}". ${
                    shouldIndex ? "Background semantic indexing started — project_semantic_search will be available in ~30s." : ""
                }`.trim()
            }, null, 2)
        }]
    };
}
