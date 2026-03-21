import { getProject } from "../core/projectRegistry.js";
import { buildSemanticIndex, loadCachedIndex } from "../indexer/semanticIndexer.js";

const cachedIndexes = {};

export async function projectIndex({ project }) {
    const root = getProject(project).root;

    // Always rebuild on explicit call — ensures fresh symbols after code changes
    console.error("[index] Building semantic index:", project);
    const index = buildSemanticIndex(root);
    cachedIndexes[project] = index;

    const classCount    = (index.classes ?? []).length;
    const functionCount = (index.functions ?? []).length;

    return {
        content: [{
            type: "text",
            text: `Index built: ${classCount} classes, ${functionCount} functions/components indexed.`
        }]
    };
}

/**
 * Get the in-memory index, auto-loading from disk cache if not yet built.
 * This ensures project_find_symbol works immediately after MCP server restart.
 */
export function getIndex(project) {
    if (cachedIndexes[project]) return cachedIndexes[project];

    // Attempt to load from persisted cache (written by buildSemanticIndex)
    try {
        const root   = getProject(project).root;
        const cached = loadCachedIndex(root);
        if (cached) {
            cachedIndexes[project] = cached;
            console.error(`[index] Loaded cached index for "${project}" from disk`);
            return cached;
        }
    } catch { /* project not registered — fall through */ }

    return null;
}