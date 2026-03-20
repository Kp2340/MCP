/**
 * project_analyze — Pre-build static analyzer
 *
 * Runs BEFORE a full build to catch cheap-to-detect issues:
 *   1. Broken relative imports / require() paths
 *   2. Files referenced in imports that don't exist on disk
 *   3. Basic syntax check via Node --check (JS/TS only)
 *
 * This avoids spinning up a full Gradle/Maven/Vite build just to discover
 * a typo in an import path — saving 30–120 seconds per autofix attempt.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { IGNORE_FOLDERS } from "../core/constants.js";

const JS_EXTENSIONS  = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs"]);
const RESOLVABLE_EXT = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.ts"];

/** Try to resolve a relative import path to an actual file. */
function resolveImport(fromFile, importPath) {
    if (!importPath.startsWith(".")) return true;  // non-relative = skip
    const base = path.resolve(path.dirname(fromFile), importPath);
    return RESOLVABLE_EXT.some(ext => fs.existsSync(base + ext));
}

/** Extract all import/require specifiers from a JS/TS file. */
function extractImports(content) {
    const specifiers = [];
    const patterns = [
        /import\s+.*?from\s+['"](.*?)['"];/g,
        /require\s*\(\s*['"](.*?)['"]\s*\)/g,
        /import\s*\(\s*['"](.*?)['"]\s*\)/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(content)) !== null) specifiers.push(m[1]);
    }
    return specifiers;
}

/** Walk the project and collect broken imports. */
function checkBrokenImports(projectRoot) {
    const issues = [];

    function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const item of items) {
            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name)) continue;
                walk(path.join(dir, item.name));
                continue;
            }

            const ext = path.extname(item.name);
            if (!JS_EXTENSIONS.has(ext)) continue;

            const full = path.join(dir, item.name);
            let content;
            try { content = fs.readFileSync(full, "utf8"); }
            catch { continue; }

            const imports = extractImports(content);
            for (const imp of imports) {
                if (!resolveImport(full, imp)) {
                    issues.push({
                        file:   path.relative(projectRoot, full),
                        import: imp,
                        issue:  "Import path not found on disk"
                    });
                }
            }
        }
    }

    walk(projectRoot);
    return issues;
}

/** Quick Node syntax check on JS/JSX files (skips TS — needs tsc). */
function checkSyntax(projectRoot) {
    const issues = [];

    function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const item of items) {
            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name)) continue;
                walk(path.join(dir, item.name));
                continue;
            }

            const ext = path.extname(item.name);
            if (ext !== ".js" && ext !== ".jsx" && ext !== ".mjs") continue;

            const full = path.join(dir, item.name);
            const result = spawnSync("node", ["--check", full], { encoding: "utf8" });

            if (result.status !== 0 && result.stderr) {
                issues.push({
                    file:  path.relative(projectRoot, full),
                    issue: result.stderr.trim().split("\n")[0]  // first line only
                });
            }
        }
    }

    walk(projectRoot);
    return issues;
}

/** MCP tool handler */
export function analyzeProject({ project }) {
    const config = getProject(project);
    const root   = config.root;

    const brokenImports = checkBrokenImports(root);
    const syntaxErrors  = config.type !== "liferay-backend" && config.type !== "spring-boot"
        ? checkSyntax(root)
        : [];  // Node --check doesn't apply to Java projects

    const total = brokenImports.length + syntaxErrors.length;

    if (total === 0) {
        return {
            content: [{ type: "text", text: "Static analysis passed — no issues found." }]
        };
    }

    const lines = [];

    if (brokenImports.length > 0) {
        lines.push(`Broken imports (${brokenImports.length}):`);
        for (const i of brokenImports) {
            lines.push(`  ${i.file}: import '${i.import}' — ${i.issue}`);
        }
    }

    if (syntaxErrors.length > 0) {
        lines.push(`Syntax errors (${syntaxErrors.length}):`);
        for (const e of syntaxErrors) {
            lines.push(`  ${e.file}: ${e.issue}`);
        }
    }

    return {
        content: [{ type: "text", text: lines.join("\n") }]
    };
}
