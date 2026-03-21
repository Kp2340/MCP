/**
 * project_analyze — Pre-build static analyzer
 *
 * Runs BEFORE a full build to catch cheap-to-detect issues:
 *   1. Broken relative imports / require() paths — including tsconfig.json alias resolution
 *   2. Files referenced in imports that don't exist on disk
 *   3. Batched syntax check via Node --check (JS/JSX — SYNTAX_BATCH_SIZE files per spawn)
 *   4. TypeScript type-check via tsc --noEmit (nextjs / react-vite only)
 *
 * Improvements over v1:
 *   - Alias resolution: @/components/... resolved via tsconfig.json/jsconfig.json paths
 *   - Batched syntax: one node --check per 50 files instead of one per file
 *   - TypeScript: tsc --noEmit surfaces TS type errors before full build
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { IGNORE_FOLDERS, SYNTAX_BATCH_SIZE } from "../core/constants.js";

const JS_EXTENSIONS  = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs"]);
const RESOLVABLE_EXT = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.ts"];

/**
 * Load path aliases from tsconfig.json or jsconfig.json if present.
 * Returns a map of alias prefix -> array of resolved base paths.
 * Example: { "@/": ["/abs/path/to/src/"] }
 */
function loadAliases(projectRoot) {
    const aliases = {};
    for (const cfgFile of ["tsconfig.json", "jsconfig.json"]) {
        const cfgPath = path.join(projectRoot, cfgFile);
        if (!fs.existsSync(cfgPath)) continue;
        try {
            const cfg    = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            const paths  = cfg.compilerOptions?.paths || {};
            const base   = cfg.compilerOptions?.baseUrl || ".";
            for (const [alias, targets] of Object.entries(paths)) {
                const prefix   = alias.replace("*", "");
                const resolved = targets.map(t =>
                    path.resolve(projectRoot, base, t.replace("*", ""))
                );
                aliases[prefix] = resolved;
            }
        } catch { /* malformed config — skip */ }
        break;
    }
    return aliases;
}

/** Try to resolve an import path to an actual file, including aliases. */
function resolveImport(fromFile, importPath, aliases = {}) {
    // Alias resolution first
    for (const [prefix, bases] of Object.entries(aliases)) {
        if (importPath.startsWith(prefix)) {
            const suffix = importPath.slice(prefix.length);
            for (const base of bases) {
                const candidate = path.join(base, suffix);
                if (RESOLVABLE_EXT.some(ext => fs.existsSync(candidate + ext))) return true;
            }
            return false;  // alias matched but file not found
        }
    }
    // Non-relative, non-alias = node_modules package = skip
    if (!importPath.startsWith(".")) return true;
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
    const issues  = [];
    const aliases = loadAliases(projectRoot);

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
                if (!resolveImport(full, imp, aliases)) {
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

/** Collect all JS/JSX/MJS files for batched syntax checking. */
function collectJsFiles(projectRoot) {
    const files = [];
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
            if (ext === ".js" || ext === ".jsx" || ext === ".mjs") files.push(path.join(dir, item.name));
        }
    }
    walk(projectRoot);
    return files;
}

/**
 * Batched Node syntax check — spawns node --check on SYNTAX_BATCH_SIZE files at once.
 * Dramatically faster than one subprocess per file on large projects.
 */
function checkSyntax(projectRoot) {
    const issues = [];
    const files  = collectJsFiles(projectRoot);

    for (let i = 0; i < files.length; i += SYNTAX_BATCH_SIZE) {
        const batch  = files.slice(i, i + SYNTAX_BATCH_SIZE);
        const result = spawnSync("node", ["--check", ...batch], { encoding: "utf8" });
        if (result.status !== 0 && result.stderr) {
            result.stderr.trim().split("\n").forEach(line => {
                // node --check prints: /abs/path/file.js:line:col: SyntaxError: ...
                const m = line.match(/^(.+?):(\d+):\d+:(.+)$/);
                if (m) {
                    issues.push({
                        file:  path.relative(projectRoot, m[1]),
                        issue: `line ${m[2]}:${m[3].trim()}`
                    });
                }
            });
        }
    }
    return issues;
}

/**
 * TypeScript type-check via tsc --noEmit.
 * Only fires for nextjs / react-vite projects with a tsconfig.json.
 */
function checkTypeScript(projectRoot, projectType) {
    if (projectType !== "nextjs" && projectType !== "react-vite") return [];
    const tsconfigPath = path.join(projectRoot, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) return [];

    const result = spawnSync(
        "npx", ["tsc", "--noEmit", "--pretty", "false"],
        { cwd: projectRoot, encoding: "utf8", timeout: 60000 }
    );

    const output = ((result.stdout || "") + (result.stderr || "")).trim();
    if (!output) return [];

    return output.split("\n")
        .filter(l => l.includes("error TS"))
        .slice(0, 20)
        .map(l => {
            const m = l.match(/^(.+?)\((\d+),\d+\):\s*(.+)$/);
            return m
                ? { file: path.relative(projectRoot, m[1].trim()), issue: `line ${m[2]}: ${m[3].trim()}` }
                : { file: "unknown", issue: l.trim() };
        });
}

/** MCP tool handler */
export function analyzeProject({ project }) {
    const config = getProject(project);
    const root   = config.root;
    const isJava = config.type === "liferay-backend" || config.type === "spring-boot";

    const brokenImports = isJava ? [] : checkBrokenImports(root);
    const syntaxErrors  = isJava ? [] : checkSyntax(root);
    const tsErrors      = isJava ? [] : checkTypeScript(root, config.type);

    const total = brokenImports.length + syntaxErrors.length + tsErrors.length;

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

    if (tsErrors.length > 0) {
        lines.push(`TypeScript errors (${tsErrors.length}):`);
        for (const e of tsErrors) {
            lines.push(`  ${e.file}: ${e.issue}`);
        }
    }

    return {
        content: [{ type: "text", text: lines.join("\n") }]
    };
}
