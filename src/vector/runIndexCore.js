import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";

function chunkCode(code) {
    const chunks = [];
    const parts = code.split(/function |export function |class |public |private |protected /);

    for (const part of parts) {
        if (part.length < 40) continue;
        chunks.push(part.substring(0, 2000));
    }

    if (chunks.length === 0) {
        chunks.push(code.substring(0, 2000));
    }

    return chunks;
}

export async function indexProject(projectRoot, projectName, extraExtensions = []) {
    const collection = await getCollection(projectName);

    // Merge default indexable extensions with any project-specific extras
    const extensions = [...new Set([...INDEXABLE_EXTENSIONS, ...extraExtensions])];

    async function walk(dir) {
        let items;
        try {
            items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const item of items) {
            const full = path.join(dir, item.name);

            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name)) continue;
                await walk(full);
                continue;
            }

            const ext = path.extname(item.name);
            if (!extensions.includes(ext)) continue;

            try {
                const code = fs.readFileSync(full, "utf8");
                const chunks = chunkCode(code);

                for (const chunk of chunks) {
                    const embedding = await embed(chunk);
                    await collection.add({
                        ids: [Buffer.from(full + chunk).toString("base64").substring(0, 512)],
                        documents: [chunk],
                        embeddings: [embedding]
                    });
                }

                console.error("Indexed:", path.relative(projectRoot, full));
            } catch (err) {
                console.error("Index error:", path.relative(projectRoot, full), err.message);
            }
        }
    }

    await walk(projectRoot);
    console.error("Indexing completed for:", projectName);
}
