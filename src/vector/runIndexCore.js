import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";

function chunkCode(code) {
    const chunks = [];
    const parts = code.split(/(?=function |export function |export default function |class |export class )/);

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
    let indexed = 0;
    let errors = 0;

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

            if (!INDEXABLE_EXTENSIONS.includes(path.extname(item.name))) continue;

            try {
                const code = fs.readFileSync(full, "utf8");
                const chunks = chunkCode(code);

                for (const chunk of chunks) {
                    const embedding = await embed(chunk);
                    const id = Buffer.from(full + chunk.substring(0, 50)).toString("base64");

                    await collection.add({
                        ids: [id],
                        documents: [chunk],
                        embeddings: [embedding]
                    });
                }

                indexed++;
                if (indexed % 20 === 0) console.log(`[index] Indexed ${indexed} files...`);

            } catch (err) {
                errors++;
                console.warn(`[index] Error on ${full}: ${err.message}`);
            }
        }
    }

    await walk(projectRoot);
    console.log(`[index] Complete — ${indexed} files indexed, ${errors} errors`);
}
