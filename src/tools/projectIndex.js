import { getProject } from "../core/projectRegistry.js";
import { buildSemanticIndex } from "../indexer/semanticIndexer.js";

export async function projectIndex({ project, force = true }) {
  const root = getProject(project).root;

  console.error("[index] Rebuilding index:", project);

  const index = buildSemanticIndex(root);

  return {
    content: [{
      type: "text",
      text: `Index rebuilt: ${index.classes.length} classes, ${index.functions.length} functions`
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