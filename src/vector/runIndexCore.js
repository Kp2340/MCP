import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";

const IGNORE_FOLDERS = [
    "node_modules",
    ".git",
    ".next",
    "out",
    "dist",
    "build",
    "target",
    ".gradle",
    ".cache"
];

function chunkCode(code) {

    const chunks = [];

    const parts = code.split(/function |export function |class /);

    for (const part of parts) {

        if (part.length < 40) continue;

        chunks.push(part.substring(0, 2000));
    }

    if (chunks.length === 0) {
        chunks.push(code.substring(0, 2000));
    }

    return chunks;
}

export async function indexProject(projectRoot, projectName) {

    const collection = await getCollection(projectName);

    async function walk(dir) {

        const items = fs.readdirSync(dir, { withFileTypes: true });

        for (const item of items) {

            const full = path.join(dir, item.name);

            if (item.isDirectory()) {

                if (IGNORE_FOLDERS.includes(item.name)) continue;

                await walk(full);
                continue;
            }

            if (
                full.endsWith(".js") ||
                full.endsWith(".ts") ||
                full.endsWith(".tsx") ||
                full.endsWith(".jsx")
            ) {

                try {

                    const code = fs.readFileSync(full, "utf8");

                    const chunks = chunkCode(code);

                    for (const chunk of chunks) {

                        const embedding = await embed(chunk);

                        await collection.add({
                            ids: [Buffer.from(full + chunk).toString("base64")],
                            documents: [chunk],
                            embeddings: [embedding]
                        });

                    }

                    console.log("Indexed:", full);

                } catch (err) {

                    console.error("Index error:", full, err);

                }

            }
        }
    }

    await walk(projectRoot);

    console.log("Indexing completed");
}