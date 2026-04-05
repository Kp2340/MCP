/**
 * src/http/workspaceRoutes.js
 *
 * Workspace Sync — lets remote users push their local project files to this
 * server so the MCP agent can work on them, then pull the changes back.
 *
 * Flow:
 *   1. Friend's IDE extension calls POST /workspace/push  with a zip of their project
 *   2. Server extracts it to data/workspaces/<user>/<projectName>/
 *   3. Server auto-registers the project in the registry
 *   4. Friend submits a job via POST /run  (now project exists on this machine)
 *   5. Agent works on the files
 *   6. Friend calls GET /workspace/pull/:project  to download the modified files as zip
 *   7. IDE extension extracts zip back onto their local machine
 *
 * Endpoints:
 *   POST   /workspace/push              Upload project as zip, register it
 *   GET    /workspace/pull/:project     Download current project files as zip
 *   GET    /workspace/status/:project   List files + last modified times
 *   DELETE /workspace/:project          Remove workspace from server
 *
 * Security:
 *   - All endpoints require x-api-key (inherited from authMiddleware)
 *   - Each user's workspace is isolated under data/workspaces/<username>/
 *   - Users can only access their own workspaces
 *   - Max upload size: 50MB (configurable via WORKSPACE_MAX_MB in .env)
 *   - Zip path traversal attack prevented (entries normalised + validated)
 */

import fs, { createReadStream } from "fs";
import path         from "path";
import { fileURLToPath } from "url";
import AdmZip            from "adm-zip";
import { registerDynamicProject }  from "../core/projectRegistry.js";
import { config }                  from "../core/config.js";
import { createLogger }            from "../core/logger.js";

const log = createLogger("workspace");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = path.resolve(__dirname, "../../data/workspaces");

const MAX_MB = parseInt(process.env.WORKSPACE_MAX_MB || "50", 10);
const MAX_BYTES = MAX_MB * 1024 * 1024;

// ── helpers ───────────────────────────────────────────────────────────────────

function userWorkspaceDir(user, project) {
    // Sanitise both segments — no slashes, no dots, no traversal
    const safeUser    = user.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    return path.join(WORKSPACES_ROOT, safeUser, safeProject);
}

function safeExtract(zipPath, destDir) {
    // adm-zip: pure JS, works on Windows, Linux, macOS, and Docker.
    fs.mkdirSync(destDir, { recursive: true });
    const zip      = new AdmZip(zipPath);
    const entries  = zip.getEntries();
    const resolvedDest = path.resolve(destDir);

    for (const entry of entries) {
        // Normalise the entry name to strip leading slashes and collapse dots
        const entryName = entry.entryName.replace(/\\/g, "/").replace(/^\/{1,}/, "");

        // Reject null bytes, absolute paths, and dot-dot traversal segments
        if (
            entryName.includes("\0") ||
            path.isAbsolute(entryName) ||
            entryName.split("/").some(seg => seg === "..")
        ) {
            log.warn(`Zip-slip blocked: skipping entry "${entry.entryName}"`);
            continue;
        }

        const targetPath = path.resolve(resolvedDest, entryName);

        // Final containment check — catches any edge-cases the above misses
        if (!targetPath.startsWith(resolvedDest + path.sep) && targetPath !== resolvedDest) {
            log.warn(`Zip-slip blocked (containment): skipping entry "${entry.entryName}"`);
            continue;
        }

        if (entry.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
        }
    }
}

function createZip(sourceDir, zipPath) {
    const zip = new AdmZip();
    // addLocalFolder adds all files under sourceDir preserving relative paths.
    zip.addLocalFolder(sourceDir);
    zip.writeZip(zipPath);
}

function walkFiles(dir, base) {
    const results = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const full = path.join(dir, item.name);
        const rel  = path.relative(base, full).replace(/\\/g, "/");
        if (item.isDirectory()) {
            results.push(...walkFiles(full, base));
        } else {
            const stat = fs.statSync(full);
            results.push({ path: rel, size: stat.size, modified: stat.mtime.toISOString() });
        }
    }
    return results;
}

// ── route attachment ──────────────────────────────────────────────────────────

/**
 * Wraps an async route handler so any rejected promise is forwarded to
 * Express's next(err) — caught by the global error handler in startHttpServer.
 * Without this, async throws in route handlers crash silently in Express 4.
 */
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function attachWorkspaceRoutes(app) {

    // ── POST /workspace/push ─────────────────────────────────────────────────
    // Body: multipart/form-data  field: file (zip)  field: project (name)
    // OR:   application/octet-stream with ?project=name header
    //
    // The client sends a zip of the project root. We extract it into
    // data/workspaces/<user>/<project>/ and register it in the project registry.
    app.post("/workspace/push", asyncRoute(async (req, res) => {
        const user    = req.user || "anonymous";
        const project = (req.query.project || req.headers["x-project"] || "").trim()
            .replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

        if (!project) {
            return res.status(400).json({
                error: "Provide project name via ?project=name query param or x-project header"
            });
        }

        // Buffer the incoming zip (raw body)
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_BYTES) {
                res.status(413).json({ error: `Project zip exceeds ${MAX_MB}MB limit` });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        }

        const zipBuffer = Buffer.concat(chunks);
        if (zipBuffer.length < 4) {
            return res.status(400).json({ error: "Empty or invalid zip file" });
        }

        const workspaceDir = userWorkspaceDir(user, project);
        const tmpZip = path.join(WORKSPACES_ROOT, `${user}-${project}-${Date.now()}.zip`);

        try {
            fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
            fs.writeFileSync(tmpZip, zipBuffer);

            // Wipe and re-extract for clean sync
            if (fs.existsSync(workspaceDir)) {
                fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
            safeExtract(tmpZip, workspaceDir);

            // Register in the project registry so /run can find it
            registerDynamicProject(project, workspaceDir, {});

            const files = walkFiles(workspaceDir, workspaceDir);
            log.info(`Workspace pushed: user=${user} project=${project} files=${files.length} bytes=${totalBytes}`);

            res.json({
                ok:          true,
                project,
                user,
                serverPath:  workspaceDir,
                fileCount:   files.length,
                bytes:       totalBytes,
                message:     `Project "${project}" is ready. Submit jobs with: POST /run  {"project": "${project}", "prompt": "..."}`,
            });
        } catch (err) {
            log.error(`Workspace push error: ${err.message}`);
            res.status(500).json({ error: err.message });
        } finally {
            try { fs.unlinkSync(tmpZip); } catch {}
        }
    }));

    // ── GET /workspace/pull/:project ─────────────────────────────────────────
    // Returns the current workspace as a zip file.
    // IDE extension downloads this and extracts it locally to apply changes.
    app.get("/workspace/pull/:project", (req, res) => {
        const user    = req.user || "anonymous";
        const project = req.params.project.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const workspaceDir = userWorkspaceDir(user, project);

        if (!fs.existsSync(workspaceDir)) {
            return res.status(404).json({
                error: `No workspace found for project "${project}". Push your project first via POST /workspace/push?project=${project}`
            });
        }

        const tmpZip = path.join(WORKSPACES_ROOT, `${user}-${project}-pull-${Date.now()}.zip`);
        try {
            createZip(workspaceDir, tmpZip);
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${project}.zip"`);
            const stream = createReadStream(tmpZip);
            stream.pipe(res);
            stream.on("close", () => {
                try { fs.unlinkSync(tmpZip); } catch {}
            });
        } catch (err) {
            log.error(`Workspace pull error: ${err.message}`);
            try { fs.unlinkSync(tmpZip); } catch {}
            res.status(500).json({ error: err.message });
        }
    });

    // ── GET /workspace/status/:project ───────────────────────────────────────
    // Returns the file tree + modification times so the IDE can diff
    // before deciding whether to pull.
    app.get("/workspace/status/:project", (req, res) => {
        const user    = req.user || "anonymous";
        const project = req.params.project.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const workspaceDir = userWorkspaceDir(user, project);

        if (!fs.existsSync(workspaceDir)) {
            return res.status(404).json({ error: `No workspace for "${project}"` });
        }
        const files = walkFiles(workspaceDir, workspaceDir);
        res.json({ project, user, serverPath: workspaceDir, files });
    });

    // ── DELETE /workspace/:project ────────────────────────────────────────────
    // Remove a workspace from the server once done.
    app.delete("/workspace/:project", (req, res) => {
        const user    = req.user || "anonymous";
        const project = req.params.project.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const workspaceDir = userWorkspaceDir(user, project);

        if (!fs.existsSync(workspaceDir)) {
            return res.status(404).json({ error: `No workspace for "${project}"` });
        }
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        log.info(`Workspace deleted: user=${user} project=${project}`);
        res.json({ ok: true, message: `Workspace "${project}" deleted from server.` });
    });

    log.info("Workspace routes: POST /workspace/push  GET /workspace/pull/:p  DELETE /workspace/:p");
}
