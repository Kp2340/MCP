/**
 * src/core/projectDetector.js
 *
 * Auto-detects project type and build command by inspecting
 * signature files in the project root.
 *
 * Called by projectRegistry when a project path is passed directly
 * instead of a registered project name.
 *
 * Detection priority (first match wins):
 *   manage.py + odoo_* folder or __openerp__.py  → odoo
 *   manage.py (no odoo markers)                  → django
 *   build.gradle / settings.gradle               → gradle / liferay-backend
 *   pom.xml                                      → spring-boot
 *   package.json + next in deps                  → nextjs
 *   package.json + vite in deps                  → react-vite
 *   package.json (anything else)                 → nodejs
 *   requirements.txt / setup.py / pyproject.toml → python
 *   Gemfile                                      → rails
 *   go.mod                                       → go
 *   Cargo.toml                                   → rust
 *   (nothing matched)                            → unknown
 */

import fs   from "fs";
import path from "path";

function exists(root, ...parts) {
    return fs.existsSync(path.join(root, ...parts));
}

function readJson(root, file) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
    } catch {
        return null;
    }
}

function hasOdooMarker(root) {
    // Odoo modules have __manifest__.py or __openerp__.py, or a folder named odoo
    if (exists(root, "__manifest__.py")) return true;
    if (exists(root, "__openerp__.py"))  return true;
    if (exists(root, "odoo"))            return true;
    if (exists(root, "addons"))          return true;
    // Check one level deep for manifest files (multi-module repo)
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory() && exists(root, e.name, "__manifest__.py")) return true;
        }
    } catch { /* ignore */ }
    return false;
}

function detectNodeSubtype(root) {
    const pkg = readJson(root, "package.json");
    if (!pkg) return "nodejs";

    const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
    };

    if (allDeps["next"] || allDeps["next.js"])         return "nextjs";
    if (allDeps["vite"] || allDeps["@vitejs/plugin-react"]) return "react-vite";
    if (allDeps["react"])                               return "react-vite";  // CRA or plain React
    if (allDeps["express"] || allDeps["fastify"] ||
        allDeps["koa"]     || allDeps["hapi"])         return "nodejs";
    return "nodejs";
}

function detectGradleSubtype(root) {
    // Check if it's a Liferay project
    if (exists(root, "liferay-workspace-ee.properties")) return "liferay-backend";
    if (exists(root, "settings.gradle")) {
        try {
            const content = fs.readFileSync(path.join(root, "settings.gradle"), "utf-8");
            if (content.includes("liferay")) return "liferay-backend";
        } catch { /* ignore */ }
    }
    // Check build.gradle for liferay
    if (exists(root, "build.gradle")) {
        try {
            const content = fs.readFileSync(path.join(root, "build.gradle"), "utf-8");
            if (content.includes("liferay")) return "liferay-backend";
        } catch { /* ignore */ }
    }
    return "gradle";
}

/**
 * @param {string} root  absolute path to project root
 * @returns {{ type: string, buildCommand: string }}
 */
export function detectProjectType(root) {
    // ── Odoo (must check before django because both have manage.py) ──────────
    if (exists(root, "manage.py") && hasOdooMarker(root)) {
        return { type: "odoo", buildCommand: "" };
    }

    // ── Django ────────────────────────────────────────────────────────────────
    if (exists(root, "manage.py")) {
        return { type: "django", buildCommand: "" };
    }

    // ── Gradle (Liferay or plain) ─────────────────────────────────────────────
    if (exists(root, "build.gradle") || exists(root, "build.gradle.kts")) {
        const subtype = detectGradleSubtype(root);
        const cmd     = subtype === "liferay-backend" ? "gradlew build" : "./gradlew build";
        return { type: subtype, buildCommand: cmd };
    }

    // ── Maven / Spring Boot ────────────────────────────────────────────────────
    if (exists(root, "pom.xml")) {
        return { type: "spring-boot", buildCommand: "mvn clean install" };
    }

    // ── Node.js variants ──────────────────────────────────────────────────────
    if (exists(root, "package.json")) {
        const subtype    = detectNodeSubtype(root);
        const buildCmd   = subtype === "nodejs" ? "" : "npm run build";
        return { type: subtype, buildCommand: buildCmd };
    }

    // ── Python (generic) ──────────────────────────────────────────────────────
    if (exists(root, "requirements.txt") ||
        exists(root, "setup.py")         ||
        exists(root, "pyproject.toml")) {
        return { type: "python", buildCommand: "" };
    }

    // ── Ruby on Rails ─────────────────────────────────────────────────────────
    if (exists(root, "Gemfile")) {
        return { type: "rails", buildCommand: "bundle exec rake" };
    }

    // ── Go ────────────────────────────────────────────────────────────────────
    if (exists(root, "go.mod")) {
        return { type: "go", buildCommand: "go build ./..." };
    }

    // ── Rust ──────────────────────────────────────────────────────────────────
    if (exists(root, "Cargo.toml")) {
        return { type: "rust", buildCommand: "cargo build" };
    }

    // ── Fallback ──────────────────────────────────────────────────────────────
    return { type: "unknown", buildCommand: "" };
}
