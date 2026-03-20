import { queryCodebase } from "../vector/queryCodebase.js";
import { embed } from "../vector/embedder.js";
import { indexProject } from "../vector/runIndexCore.js";
import { getProject } from "../core/projectRegistry.js";

const MAX_SNIPPET = 600;
const MAX_RESULTS = 4;

let indexing = false;

function compress(doc) {
    if (!doc) return "";
    return doc.length > MAX_SNIPPET ? doc.substring(0, MAX_SNIPPET) + "\n..." : doc;
}

export async function retrieveContext(prompt, project = null) {
    try {
        const embedding = await embed(prompt);

        let docs;
        try {
            docs = await queryCodebase(embedding, project);
        } catch {
            // Collection missing — auto-build index once
            if (project && !indexing) {
                indexing = true;
                console.error("\n[retriever] Vector index missing. Building automatically...\n");
                const config = getProject(project);
                await indexProject(config.root, project);
                console.error("\n[retriever] Vector index built.\n");
                indexing = false;
            }
            docs = await queryCodebase(embedding, project);
        }

        if (!docs || docs.length === 0) return "";

        return docs.slice(0, MAX_RESULTS).map(compress).join("\n\n---\n\n");

    } catch (err) {
        console.error("[retriever] Error:", err.message);
        return "";
    }
}