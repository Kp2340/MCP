import { getProject } from "../core/projectRegistry.js";
import { buildSemanticIndex } from "../indexer/semanticIndexer.js";

let cachedIndexes = {};

export async function projectIndex({ project }) {

    const root = getProject(project).root;

    if (cachedIndexes[project]) {

        return {
            content: [{
                type: "text",
                text: "Index already exists"
            }]
        };

    }

    console.error("Building semantic index:", project);

    const index = buildSemanticIndex(root);

    cachedIndexes[project] = index;

    return {
        content: [
            {
                type: "text",
                text: "Index built successfully"
            }
        ]
    };

}

export function getIndex(project) {
    return cachedIndexes[project];
}