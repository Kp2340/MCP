import fs from "fs";
import path from "path";
import { getCollection } from "./indexCodebase.js";
import { embed } from "./embedder.js";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS } from "../core/constants.js";

// ─── Incremental index tracking ──────────────────────────────────────────────
// We store a JSON sidecar { filePath: mtime } next to the ChromaDB data.
// On re-index we skip files whose mtime hasn't changed — up to 10x faster.

function getManifestPath(projectName) {
    // Store manifest in cwd (project working dir) so it survives restarts
    // and doesn't pollute the MCP source tree
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

// ─── Code chunker ────────────────────────────────────────────────────────────
// Splits on function/class boundaries and respects a hard size cap.
// Overlap (last 200 chars of prev chunk prepended to next) preserves context
// across chunk boundaries so semantic search doesn't lose cross-boundary meaning.
const CHUNK_MAX   = 1800;  // chars — keeps each chunk well within embed token limit
const CHUNK_OVERLAP = 200; // chars overlap between consecutive chunks

function chunkCode(code) {
    const chunks  = [];
    // Split on top-level declaration boundaries
    const boundaries = /(?=^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|public|private|protected|interface|type)\s)/m;
    const parts   = code.split(boundaries).filter(p => p.trim().length >= 40);

    if (parts.length === 0) {
        // File has no recognizable boundaries (e.g. config/data files) — just window it
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

                for (let ci = 0; ci < chunks.length; ci++) {
                    const chunk     = chunks[ci];
                    const embedding = await embed(chunk);
                    // Include chunk index in ID so multiple chunks from same file get unique IDs
                    const id        = Buffer.from(`${full}::${ci}`).toString("base64").substring(0, 512);
                    const ext       = path.extname(item.name).replace(".", "");

                    try {
                        await collection.upsert({
                            ids:        [id],
                            documents:  [chunk],
                            embeddings: [embedding],
                            // Metadata enables future file-type or path filtering in queries
                            metadatas:  [{ file: rel, ext, chunkIndex: ci, mtime }]
                        });
                    } catch {
                        await collection.add({
                            ids:        [id],
                            documents:  [chunk],
                            embeddings: [embedding],
                            metadatas:  [{ file: rel, ext, chunkIndex: ci, mtime }]
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
