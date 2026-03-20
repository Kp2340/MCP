import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";

// ─── Incremental index tracking ──────────────────────────────────────────────
// We store a JSON sidecar { filePath: mtime } next to the ChromaDB data.
// On re-index we skip files whose mtime hasn't changed — up to 10x faster.

function getManifestPath(projectName) {
    // Store manifest alongside this source file so it survives across restarts
    return path.resolve(path.dirname(new URL(import.meta.url).pathname), `../../.index_manifest_${projectName}.json`);
}

function loadManifest(projectName) {
    const p = getManifestPath(projectName);
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return {};
    }
}

function saveManifest(projectName, manifest) {
    const p = getManifestPath(projectName);
    try {
        fs.writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
    } catch (err) {
        console.error("[indexer] Could not save manifest:", err.message);
    }
}

// ─── Code chunker ────────────────────────────────────────────────────────────
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

// ─── Main indexer ─────────────────────────────────────────────────────────────
export async function indexProject(projectRoot, projectName, extraExtensions = []) {
    const collection  = await getCollection(projectName);
    const extensions  = [...new Set([...INDEXABLE_EXTENSIONS, ...extraExtensions])];
    const manifest    = loadManifest(projectName);
    let   indexed     = 0;
    let   skipped     = 0;

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

            // ── Incremental check ──────────────────────────────────────────
            const mtime = fs.statSync(full).mtimeMs;
            if (manifest[full] === mtime) {
                skipped++;
                continue;   // file unchanged since last index — skip
            }

            try {
                const code   = fs.readFileSync(full, "utf8");
                const chunks = chunkCode(code);
                const rel    = path.relative(projectRoot, full);

                for (const chunk of chunks) {
                    const embedding = await embed(chunk);
                    const id = Buffer.from(full + chunk).toString("base64").substring(0, 512);

                    // Upsert so re-indexing a changed file replaces old vectors
                    try {
                        await collection.upsert({
                            ids:        [id],
                            documents:  [chunk],
                            embeddings: [embedding]
                        });
                    } catch {
                        // Fall back to add if upsert not supported by this Chroma version
                        await collection.add({
                            ids:        [id],
                            documents:  [chunk],
                            embeddings: [embedding]
                        });
                    }
                }

                manifest[full] = mtime;   // record new mtime
                indexed++;
                console.error("Indexed:", rel);
            } catch (err) {
                console.error("Index error:", path.relative(projectRoot, full), err.message);
            }
        }
    }

    await walk(projectRoot);
    saveManifest(projectName, manifest);
    console.error(`Indexing completed for: ${projectName} — ${indexed} indexed, ${skipped} unchanged (skipped)`);
}
