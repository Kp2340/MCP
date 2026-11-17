/**
 * project_register — Explicitly register a project by name + path.
 *
 * SECURITY GATES (checked in order):
 *   1. DISABLE_REMOTE_REGISTER=true  → hard block, no registration allowed.
 *   2. ALLOWED_ROOTS non-empty       → rootPath must start with one of the listed prefixes.
 *   3. Path must exist on disk       → prevents probing non-existent paths.
 *
 * After registration:
 *   - All other tools accept the project name normally
 *   - A background vector index is triggered automatically
 *   - Optionally persists to projects.json (persist: true)
 *
 * Args:
 *   name      string   friendly project name (used in all subsequent calls)
 *   path      string   absolute path to project root
 *   type      string   optional override (auto-detected if omitted)
 *   persist   boolean  if true, write to projects.json so it survives restart
 */

import path from "path";
import { registerDynamicProject, saveProject } from "../core/projectRegistry.js";
import { indexProject }                         from "../vector/runIndexCore.js";
import { createLogger }                         from "../core/logger.js";
import { config }                               from "../core/config.js";

const log = createLogger("project-register");

export async function registerProject({ name, path: rootPath, type, persist = false }) {
    if (!name || typeof name !== "string") {
        throw new Error("name is required");
    }
    if (!rootPath || typeof rootPath !== "string") {
        throw new Error("path is required — provide the absolute path to the project root");
    }

    // SECURITY GATE 1: remote registration completely disabled
    if (config.DISABLE_REMOTE_REGISTER) {
        log.warn(`project_register blocked: DISABLE_REMOTE_REGISTER=true (caller tried to register "${name}" → ${rootPath})`);
        throw new Error(
            "Remote project registration is disabled on this server. " +
            "Ask the server admin to add your project to projects.json."
        );
    }

    const resolvedRoot = path.resolve(rootPath);

    // SECURITY GATE 2: path must physically exist on THIS server's filesystem.
    // This is the most important check for remote users — if the path doesn't
    // exist on the server machine, it means the user is trying to register a
    // path from their own local machine, which can never work.
    const { default: fs } = await import("fs");
    if (!fs.existsSync(resolvedRoot)) {
        log.warn(`project_register blocked: path does not exist on this server: "${resolvedRoot}"`);
        throw new Error(
            `Path "${resolvedRoot}" does not exist on the server machine.
` +
            `This server runs on a different machine — you cannot use your local path here.
` +
            `Ask the server admin to:
` +
            `  1. Clone/copy your project to the server, then add it to projects.json, OR
` +
            `  2. Tell you the server-side path of your project if it is already there.`
        );
    }

    // SECURITY GATE 3: if ALLOWED_ROOTS is set, path must be within those roots.
    // Use case-insensitive comparison on Windows, forward-slash normalised everywhere.
    if (config.ALLOWED_ROOTS.length > 0) {
        const isWindows   = process.platform === "win32";
        const normTarget  = resolvedRoot.replace(/\\/g, "/");
        const normCompare = (p) => {
            const s = path.resolve(p).replace(/\\/g, "/");
            return isWindows ? s.toLowerCase() : s;
        };
        const normTargetCmp = isWindows ? normTarget.toLowerCase() : normTarget;

        const allowed = config.ALLOWED_ROOTS.some(r => {
            const nr = normCompare(r);
            return normTargetCmp === nr || normTargetCmp.startsWith(nr + "/");
        });
        if (!allowed) {
            log.warn(`project_register blocked: "${resolvedRoot}" is outside ALLOWED_ROOTS [${config.ALLOWED_ROOTS.join(", ")}]`);
            throw new Error(
                `Path "${resolvedRoot}" is not within any allowed root directory. ` +
                `Ask the server admin to add it to ALLOWED_ROOTS in .env.`
            );
        }
    }

    const projectConfig = registerDynamicProject(name, resolvedRoot, { type });

    if (persist) {
        saveProject(name);
    }

    // Trigger background index — don't await, let it run async
    const CODE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".py", ".go", ".rb", ".rs"];
    const exts = projectConfig.indexExtensions || [];
    const shouldIndex = exts.length === 0
        || CODE_EXTENSIONS.some(ext => exts.includes(ext));

    if (shouldIndex) {
        log.info(`Triggering background index for "${name}"...`);
        indexProject(projectConfig.root, name).then(() => {
            log.info(`Background index complete for "${name}"`);
        }).catch(err => {
            log.warn(`Background index failed for "${name}": ${err.message}`);
        });
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                registered:   true,
                name,
                root:         projectConfig.root,
                type:         projectConfig.type,
                buildCommand: projectConfig.buildCommand,
                branchPrefix: projectConfig.branchPrefix,
                indexing:     shouldIndex,
                persisted:    persist,
                message: `Project "${name}" registered. Use project: "${name}" in all subsequent tools.${
                    shouldIndex ? " Background semantic indexing started." : ""
                }`
            }, null, 2)
        }]
    };
}
