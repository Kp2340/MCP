import { getProject } from "../core/projectRegistry.js";
import { indexProject } from "./runIndexCore.js";

async function main() {

    const projectName = process.argv[2] || "jsv";

    const config = getProject(projectName);

    console.log("Building vector index for:", projectName);

    await indexProject(config.root, projectName);

    console.log("Vector index completed");

}

main().catch(err => {
    console.error("Indexing failed:", err);
});