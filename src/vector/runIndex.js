import { getProject } from "../core/projectRegistry.js";
import { indexProject } from "./runIndexCore.js";

async function main() {
    const projectName = process.argv[2] || "jsv";
    const config = getProject(projectName);

    console.error("Building vector index for:", projectName);

    // Pass project-specific extra extensions from config
    const extraExtensions = config.indexExtensions || [];
    await indexProject(config.root, projectName, extraExtensions);

    console.error("Vector index completed");
}

main().catch(err => {
    console.error("Indexing failed:", err);
});
