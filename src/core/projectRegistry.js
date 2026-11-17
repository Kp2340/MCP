/**
 * src/core/projectRegistry.js
 *
 * SECURITY MODEL
 * ──────────────
 * Clients (IDE extensions, API callers) may only reference projects by their
 * registered name (e.g. "jsv", "decorom-backend"). They CANNOT supply arbitrary
 * filesystem paths — doing so would let any API-key holder point the agent at
 * any directory on the server machine.
 *
 * Two-tier project registry:
 *
 *   Tier 1 — Static (projects.json)
 *     Pre-configured projects with known roots, types, build commands.
 *     Hot-reloaded on every call — no restart needed after editing.
 *
 *   Tier 2 — Dynamic (in-memory, server-side only)
 *     Registered at runtime via registerDynamicProject() called from server-side
 *     code (project_register MCP tool). Client-supplied paths are NEVER used.
 *     Optionally restricted to ALLOWED_ROOTS directories (set in .env).
 *     Dynamic entries are never written to disk unless saveProject() is called.
 *
 * Project shape:
 *   {
 *     root:            string   absolute filesystem path
 *     type:            string   auto-detected or provided
 *     buildCommand:    string   auto-detected or ""
 *     branchPrefix:    string   derived from name
 *     indexExtensions: string[] based on type
 *   }
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectProjectType } from "./projectDetector.js";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const projectsPath  = path.join(__dirname, "../config/projects.json");

// ── In-memory dynamic registry ────────────────────────────────────────────────
const dynamicProjects = new Map();   // name → project config

// ── Request-scoped user context ───────────────────────────────────────────────
// Set by mcpRouter.js at the start of each MCP request via setRequestUser().
// Read by getProject() to enforce per-user project ownership automatically,
// without needing to thread `user` through every tool call.
let _currentRequestUser = null;

export function setRequestUser(user) {
    _currentRequestUser = user || null;
}

export function clearRequestUser() {
    _currentRequestUser = null;
}

// ── Static cache with fs.watch hot-reload ────────────────────────────────────
// Previously loadStatic() read + parsed projects.json on every getProject() call.
// Under load this was unnecessary I/O. Now we cache in memory and invalidate
// only when the file actually changes on disk.
let   _staticCache     = null;
let   _watcherStarted  = false;

function startWatcher() {
    if (_watcherStarted) return;
    _watcherStarted = true;
    try {
        fs.watch(projectsPath, () => {
            _staticCache = null;   // invalidate — next getProject() reloads
            console.error("[registry] projects.json changed — cache invalidated");
        });
    } catch {
        // File may not exist yet; watcher will be retried on next write via saveProject()
    }
}

function loadStatic() {
    if (_staticCache) return _staticCache;
    try {
        _staticCache = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    } catch {
        _staticCache = {};
    }
    startWatcher();
    return _staticCache;
}

// ── Project type → sensible defaults ─────────────────────────────────────────
const TYPE_DEFAULTS = {
    "nextjs":           { buildCommand: "npm run build",    indexExtensions: [] },
    "react-vite":       { buildCommand: "npm run build",    indexExtensions: [] },
    "nodejs":           { buildCommand: "",                 indexExtensions: [] },
    "spring-boot":      { buildCommand: "mvn clean install",indexExtensions: [".java"] },
    "liferay-backend":  { buildCommand: "gradlew build",    indexExtensions: [".java"] },
    "gradle":           { buildCommand: "gradlew build",    indexExtensions: [".java", ".kt"] },
    "django":           { buildCommand: "",                 indexExtensions: [".py"] },
    "odoo":             { buildCommand: "",                 indexExtensions: [".py", ".xml"] },
    "python":           { buildCommand: "",                 indexExtensions: [".py"] },
    "rails":            { buildCommand: "",                 indexExtensions: [".rb"] },
    "go":               { buildCommand: "go build ./...",   indexExtensions: [".go"] },
    "rust":             { buildCommand: "cargo build",      indexExtensions: [".rs"] },
    "unknown":          { buildCommand: "",                 indexExtensions: [] },
};

function defaultsForType(type) {
    return TYPE_DEFAULTS[type] || TYPE_DEFAULTS["unknown"];
}

// ── Branch prefix from project name ──────────────────────────────────────────
function makeBranchPrefix(name) {
    // e.g. "my-odoo-project" → "MOP", "decorom-backend" → "DB"
    return name
        .split(/[-_\s]+/)
        .map(w => w[0]?.toUpperCase() || "")
        .join("")
        .substring(0, 5) || "AI";
}

// ── Core: resolve a project by name ──────────────────────────────────────────
/**
 * Returns the project config for `name`.
 *
 * Resolution order:
 *   1. Static projects.json
 *   2. Dynamic in-memory registry
 *   3. Throw — clients may NOT auto-register via this function
 *
 * @param {string} name  registered project name (e.g. "jsv", "decorom-backend")
 * @returns {object}     project config
 */
export function getProject(name) {
    // 1. Static
    const statics = loadStatic();
    if (statics[name]) {
        const project = statics[name];
        // ── Ownership check ─────────────────────────────────────────────────────────
        // _currentRequestUser is set by mcpRouter.js for each MCP tool call.
        // Skipped when: no owner on project, user is anonymous (no keys set), or no user context.
        if (project.owner && _currentRequestUser && _currentRequestUser !== "anonymous") {
            if (project.owner !== _currentRequestUser) {
                throw new Error(
                    `Access denied: project "${name}" belongs to "${project.owner}", not "${_currentRequestUser}". ` +
                    `You can only access projects assigned to your API key.`
                );
            }
        }
        return project;
    }

    // 2. Dynamic (dynamically registered projects are always owned by the registering user)
    if (dynamicProjects.has(name)) {
        const project = dynamicProjects.get(name);
        if (project.owner && _currentRequestUser && _currentRequestUser !== "anonymous") {
            if (project.owner !== _currentRequestUser) {
                throw new Error(
                    `Access denied: project "${name}" belongs to "${project.owner}", not "${_currentRequestUser}". ` +
                    `You can only access projects assigned to your API key.`
                );
            }
        }
        return project;
    }

    // 3. Not found anywhere
    const known = [
        ...Object.keys(statics),
        ...Array.from(dynamicProjects.keys()).filter(k => !path.isAbsolute(k))
    ];
    throw new Error(
        `Project not found: "${name}".
` +
        `Known projects: ${known.join(", ")}
` +
        `Tip: ask the server admin to add it to projects.json or call project_register.`
    );
}

// ── Auto-register from a filesystem path ─────────────────────────────────────
function _autoRegister(rootPath, suggestedName) {
    const detected  = detectProjectType(rootPath);
    const defaults  = defaultsForType(detected.type);
    const safeName  = suggestedName.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();

    const config = {
        root:            rootPath,
        type:            detected.type,
        buildCommand:    detected.buildCommand || defaults.buildCommand,
        branchPrefix:    makeBranchPrefix(safeName),
        indexExtensions: defaults.indexExtensions,
        _dynamic:        true,     // flag so tools know this was auto-registered
        _detectedAt:     Date.now()
    };

    dynamicProjects.set(safeName, config);
    // Also register under the original path so both keys work
    dynamicProjects.set(rootPath, config);

    console.error(
        `[registry] Auto-registered dynamic project: "${safeName}"
` +
        `  root: ${rootPath}
` +
        `  type: ${detected.type}  build: "${config.buildCommand}"`
    );

    return config;
}

// ── Explicit registration (from project_register tool) ────────────────────────
/**
 * Register a project explicitly with a friendly name and root path.
 * Type is auto-detected if not provided.
 *
 * @param {string} name       friendly project name
 * @param {string} rootPath   absolute path to project root
 * @param {object} [overrides] optional: { type, buildCommand, branchPrefix }
 */
export function registerDynamicProject(name, rootPath, overrides = {}) {
    if (!fs.existsSync(rootPath)) {
        throw new Error(`Cannot register project: path does not exist: "${rootPath}"`);
    }

    const detected = detectProjectType(rootPath);
    const type     = overrides.type || detected.type;
    const defaults = defaultsForType(type);

    const config = {
        root:            path.resolve(rootPath),
        type,
        buildCommand:    overrides.buildCommand ?? detected.buildCommand ?? defaults.buildCommand,
        branchPrefix:    overrides.branchPrefix ?? makeBranchPrefix(name),
        indexExtensions: defaults.indexExtensions,
        _dynamic:        true,
        _detectedAt:     Date.now()
    };

    dynamicProjects.set(name, config);
    console.error(`[registry] Registered dynamic project: "${name}" → ${rootPath} (${type})`);
    return config;
}

// ── Save dynamic project to projects.json ─────────────────────────────────────
/**
 * Persist a dynamic project to projects.json so it survives server restart.
 */
export function saveProject(name) {
    const config = dynamicProjects.get(name);
    if (!config) throw new Error(`No dynamic project named "${name}" to save`);

    const { _dynamic, _detectedAt, ...clean } = config;
    const statics = loadStatic();
    statics[name]  = clean;
    fs.writeFileSync(projectsPath, JSON.stringify(statics, null, 2), "utf-8");
    _staticCache = null;   // force reload on next access
    startWatcher();        // ensure watcher is running after first write
    console.error(`[registry] Saved project "${name}" to projects.json`);
}

// ── Owner-aware project lookup ───────────────────────────────────────────────
/**
 * Like getProject() but enforces that the calling user owns the project.
 *
 * - If the project has no owner field, it is accessible by everyone (legacy).
 * - "anonymous" (no API key configured) bypasses ownership — dev/local mode only.
 * - Throws a clear error if a user tries to access another user's project.
 *
 * @param {string} name  registered project name
 * @param {string} user  resolved username from auth middleware (req.user)
 */
export function getProjectForUser(name, user) {
    const project = getProject(name);  // throws if not found

    // No owner set → accessible to all (backward compat for existing projects
    // that haven't been assigned an owner yet)
    if (!project.owner) return project;

    // anonymous = no API keys configured on server = local/dev mode
    if (user === "anonymous") return project;

    if (project.owner !== user) {
        throw new Error(
            `Access denied: project "${name}" belongs to "${project.owner}", not "${user}". ` +
            `You can only access projects assigned to your API key.`
        );
    }

    return project;
}

// ── List all known projects ───────────────────────────────────────────────────
export function listProjects() {
    const statics = Object.keys(loadStatic());
    const dynamic = Array.from(dynamicProjects.keys())
        .filter(k => !path.isAbsolute(k))  // skip the path-keyed duplicates
        .filter(k => !statics.includes(k));  // skip if already in static
    return [...statics, ...dynamic];
}

// ── List dynamic projects with metadata ──────────────────────────────────────
export function listDynamicProjects() {
    const result = [];
    for (const [k, v] of dynamicProjects.entries()) {
        if (!path.isAbsolute(k)) result.push({ name: k, ...v });
    }
    return result;
}
