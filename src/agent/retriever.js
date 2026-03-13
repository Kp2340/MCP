import { queryCodebase } from "../vector/queryCodebase.js";
import { embed } from "../vector/embedder.js";
import { indexProject } from "../vector/runIndexCore.js";
import { getProject } from "../core/projectRegistry.js";

const MAX_SNIPPET = 600;
const MAX_RESULTS = 4;

let indexing = false;

function compress(doc) {

    if (!doc) return "";

    if (doc.length > MAX_SNIPPET) {
        return doc.substring(0, MAX_SNIPPET) + "\n...";
    }

    return doc;
}

export async function retrieveContext(prompt, project = null) {

    try {

        const embedding = await embed(prompt);

        let docs;

        try {

            docs = await queryCodebase(embedding, project);

        } catch (err) {

            if (!project) throw err;

            if (!indexing) {

                indexing = true;

                console.log("\nVector index missing. Building automatically...\n");

                const config = getProject(project);

                await indexProject(config.root, project);

                console.log("\nVector index built successfully\n");

                indexing = false;

            }

            docs = await queryCodebase(embedding, project);
        }

        if (!docs || docs.length === 0) {
            return "";
        }

        return docs
            .slice(0, MAX_RESULTS)
            .map(compress)
            .join("\n\n");

    } catch (err) {

        console.error("Retriever error:", err);

        return "";

    }
}