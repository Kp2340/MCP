import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";
import { deduplicate } from "../utils/requestDeduplicator.js";

// --- Incremental index tracking -----------------------------------------------
// We store a JSON sidecar { filePath: mtime } next to the ChromaDB data.
// On re-index we skip files whose mtime hasn't changed -- up to 10x faster.

function getManifestPath(projectName) {
    return path.resolve(process.cwd(), `.index_manifest_${projectName}.json`);
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

// --- Code chunker -------------------------------------------------------------
// Splits on function/class boundaries and respects a hard size cap.
// Overlap (last 200 chars of prev chunk prepended to next) preserves context
// across chunk boundaries so semantic search doesn't lose cross-boundary meaning.
const CHUNK_MAX    = 1800;  // chars -- keeps each chunk well within embed token limit
const CHUNK_OVERLAP = 200;  // chars overlap between consecutive chunks

function chunkCode(code) {
    const chunks = [];
    const boundaries = /(?=^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|public|private|protected|interface|type)\s)/m;
    const parts = code.split(boundaries).filter(p => p.trim().length >= 40);

    if (parts.length === 0) {
        for (let i = 0; i < code.length; i += CHUNK_MAX - CHUNK_OVERLAP) {
            chunks.push(code.substring(i, i + CHUNK_MAX));
        }
        return chunks;
    }

    let prev = "";
    for (const part of parts) {
        const chunk = (prev + part).substring(0, CHUNK_MAX);
        chunks.push(chunk);
        prev = part.length > CHUNK_OVERLAP ? part.slice(-CHUNK_OVERLAP) : part;
    }
    return chunks;
}

// --- Public entry point -------------------------------------------------------
/**
 * Index (or re-index) a project's codebase into ChromaDB.
 *
 * Deduplicates concurrent calls: if background indexing is already running
 * for this project, the second caller waits for it to finish instead of
 * starting a redundant rebuild.
 *
 * @param {string}   projectRoot
 * @param {string}   projectName
 * @param {string[]} [extraExtensions]
 */
export function indexProject(projectRoot, projectName, extraExtensions = []) {
    return deduplicate(`index:${projectName}`, () =>
        _indexProjectImpl(projectRoot, projectName, extraExtensions)
    );
}

// --- Core implementation -----------------------------------------------------
async function _indexProjectImpl(projectRoot, projectName, extraExtensions = []) {
    const collection = await getCollection(projectName);
    const extensions = [...new Set([...INDEXABLE_EXTENSIONS, ...extraExtensions])];
    const manifest   = loadManifest(projectName);
    let   indexed    = 0;
    let   skipped    = 0;
    let   deleted    = 0;   // files removed from disk since last index

    // Track all files seen in this run -- any manifest key NOT in this set
    // corresponds to a file that was deleted from disk and should be purged
    // from the vector collection so stale results don't pollute searches.
    const seenFiles = new Set();

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

            seenFiles.add(full);

            // --- Incremental check -------------------------------------------
            const mtime = fs.statSync(full).mtimeMs;
            if (manifest[full] === mtime) {
                skipped++;
                continue;   // file unchanged since last index -- skip
            }

            try {
                const code   = fs.readFileSync(full, "utf8");
                const chunks = chunkCode(code);
                const rel    = path.relative(projectRoot, full);

                for (let ci = 0; ci < chunks.length; ci++) {
                    const chunk     = chunks[ci];
                    const embedding = await embed(chunk);
                    const id        = Buffer.from(`${full}::${ci}`).toString("base64").substring(0, 512);
                    const fileExt   = path.extname(item.name).replace(".", "");

                    try {
                        await collection.upsert({
                            ids:        [id],
                            documents:  [chunk],
                            embeddings: [embedding],
                            metadatas:  [{ file: rel, ext: fileExt, chunkIndex: ci, mtime }]
                        });
                    } catch (upsertErr) {
                        console.error(`[indexer] upsert failed for ${rel} chunk ${ci}:`, upsertErr.message);
                    }
                }

                manifest[full] = mtime;
                indexed++;
                console.error("Indexed:", rel);
            } catch (err) {
                console.error("Index error:", path.relative(projectRoot, full), err.message);
            }
        }
    }

    await walk(projectRoot);

    // --- Purge stale entries for deleted files ---------------------------------
    // Any file that was in the manifest but NOT seen in this run was deleted.
    // Remove its vector entries from ChromaDB so stale results don't appear.
    const stalePaths = Object.keys(manifest).filter(p => !seenFiles.has(p));
    for (const stalePath of stalePaths) {
        try {
            // Delete all chunks for this file (chunkIndex 0, 1, 2 ...)
            // We find them by querying metadatas where file == rel
            const rel = path.relative(projectRoot, stalePath);
            const existing = await collection.get({ where: { file: rel } });
            if (existing?.ids?.length) {
                await collection.delete({ ids: existing.ids });
                console.error(`[indexer] Purged ${existing.ids.length} chunks for deleted file: ${rel}`);
            }
            delete manifest[stalePath];
            deleted++;
        } catch (err) {
            // Non-fatal: stale entries won't break anything, just waste space
            console.error(`[indexer] Could not purge ${stalePath}:`, err.message);
        }
    }

    saveManifest(projectName, manifest);
    console.error(
        `Indexing completed for: ${projectName} -- ` +
        `${indexed} indexed, ${skipped} unchanged (skipped), ${deleted} deleted files purged`
    );
}
