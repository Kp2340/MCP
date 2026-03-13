import { getProject } from "../core/projectRegistry.js";
import { buildSemanticIndex } from "../indexer/semanticIndexer.js";

const cachedIndexes = {};

export async function projectIndex({ project, force = false }) {
    const root = getProject(project).root;

    if (cachedIndexes[project] && !force) {
        const { classes, functions } = cachedIndexes[project];
        return {
            content: [{
                type: "text",
                text: `Index already exists: ${classes.length} classes, ${functions.length} functions`
            }]
        };
    }

    console.log(`[index] Building semantic index for ${project}...`);
    const index = buildSemanticIndex(root);
    cachedIndexes[project] = index;

    return {
        content: [{
            type: "text",
            text: `Index built: ${index.classes.length} classes, ${index.functions.length} functions`
        }]
    };
}

export function getIndex(project) {
    return cachedIndexes[project] || null;
}

export function clearIndex(project) {
    delete cachedIndexes[project];
}
