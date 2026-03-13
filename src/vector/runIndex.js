import { getProject } from "../core/projectRegistry.js";
import { indexProject } from "./runIndexCore.js";

async function main() {
    const projectName = process.argv[2];

    if (!projectName) {
        console.error("Usage: node src/vector/runIndex.js <project-name>");
        process.exit(1);
    }

    const config = getProject(projectName);

    console.log(`Building vector index for: ${projectName}`);
    console.log(`Root: ${config.root}`);

    await indexProject(config.root, projectName);

    console.log("Vector index completed successfully");
}

main().catch(err => {
    console.error("Indexing failed:", err.message);
    process.exit(1);
});
