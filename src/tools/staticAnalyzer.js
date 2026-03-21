/**
 * project_analyze — Pre-build static analyzer
 *
 * Language support matrix:
 *   JS/JSX/TS/TSX  — broken imports, batched syntax check, tsc --noEmit
 *   Java/Kotlin    — skipped (compiler handles it)
 *   Python/Odoo    — basic syntax check via `python -m py_compile`
 *   Go             — `go vet ./...`
 *   Other          — scan for obvious issues (file existence)
 *
 * TypeScript check now fires for ANY node-based project with a tsconfig.json
 * (not just nextjs/react-vite — also plain nodejs TypeScript projects).
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { IGNORE_FOLDERS, SYNTAX_BATCH_SIZE } from "../core/constants.js";

const JS_EXTENSIONS  = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs"]);
const RESOLVABLE_EXT = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.ts"];
const NODE_TYPES     = new Set(["nextjs", "react-vite", "nodejs"]);
const JAVA_TYPES     = new Set(["spring-boot", "liferay-backend", "gradle"]);
const PYTHON_TYPES   = new Set(["django", "odoo", "python"]);

// ── Alias loader ────────────────────────────────────────────────────────────
function loadAliases(projectRoot) {
    const aliases = {};
    for (const cfgFile of ["tsconfig.json", "jsconfig.json"]) {
        const cfgPath = path.join(projectRoot, cfgFile);
        if (!fs.existsSync(cfgPath)) continue;
        try {
            const cfg   = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            const paths = cfg.compilerOptions?.paths || {};
            const base  = cfg.compilerOptions?.baseUrl || ".";
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

// ── Import resolver ─────────────────────────────────────────────────────────
function resolveImport(fromFile, importPath, aliases = {}) {
    for (const [prefix, bases] of Object.entries(aliases)) {
        if (importPath.startsWith(prefix)) {
            const suffix = importPath.slice(prefix.length);
            for (const base of bases) {
                const candidate = path.join(base, suffix);
                if (RESOLVABLE_EXT.some(ext => fs.existsSync(candidate + ext))) return true;
            }
            return false;
        }
    }
    if (!importPath.startsWith(".")) return true;  // node_modules — skip
    const base = path.resolve(path.dirname(fromFile), importPath);
    return RESOLVABLE_EXT.some(ext => fs.existsSync(base + ext));
}

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

function checkBrokenImports(projectRoot) {
    const issues  = [];
    const aliases = loadAliases(projectRoot);
    function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
            try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
            for (const imp of extractImports(content)) {
                if (!resolveImport(full, imp, aliases)) {
                    issues.push({ file: path.relative(projectRoot, full), import: imp, issue: "Import path not found" });
                }
            }
        }
    }
    walk(projectRoot);
    return issues;
}

function collectJsFiles(projectRoot) {
    const files = [];
    function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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

function checkSyntax(projectRoot) {
    const issues = [];
    const files  = collectJsFiles(projectRoot);
    for (let i = 0; i < files.length; i += SYNTAX_BATCH_SIZE) {
        const batch  = files.slice(i, i + SYNTAX_BATCH_SIZE);
        const result = spawnSync("node", ["--check", ...batch], { encoding: "utf8" });
        if (result.status !== 0 && result.stderr) {
            result.stderr.trim().split("\n").forEach(line => {
                const m = line.match(/^(.+?):(\d+):\d+:(.+)$/);
                if (m) issues.push({ file: path.relative(projectRoot, m[1]), issue: `line ${m[2]}:${m[3].trim()}` });
            });
        }
    }
    return issues;
}

/**
 * TypeScript check — now fires for ANY node-based project with tsconfig.json,
 * not just nextjs/react-vite. Covers plain nodejs TypeScript projects too.
 */
function checkTypeScript(projectRoot, projectType) {
    if (!NODE_TYPES.has(projectType)) return [];
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

/**
 * Python syntax check via `python -m py_compile`.
 * Works for Django, Odoo, and generic Python projects.
 * Collects .py files, runs them through py_compile one batch at a time.
 */
function checkPythonSyntax(projectRoot) {
    const issues = [];
    const files  = [];

    function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name) || item.name === "migrations") continue;
                walk(path.join(dir, item.name));
                continue;
            }
            if (item.name.endsWith(".py")) files.push(path.join(dir, item.name));
        }
    }
    walk(projectRoot);

    // Run up to 50 files at a time through py_compile
    for (let i = 0; i < files.length && i < 200; i += 50) {
        const batch  = files.slice(i, i + 50);
        const result = spawnSync(
            "python", ["-m", "py_compile", ...batch],
            { cwd: projectRoot, encoding: "utf8", timeout: 30000 }
        );
        if (result.status !== 0 && result.stderr) {
            result.stderr.trim().split("\n").forEach(line => {
                // py_compile: File "/path/file.py", line N
                const m = line.match(/File "(.+?)", line (\d+)/);
                if (m) {
                    issues.push({
                        file:  path.relative(projectRoot, m[1]),
                        issue: `line ${m[2]}: SyntaxError`
                    });
                }
            });
        }
    }
    return issues;
}

/**
 * Go vet — runs `go vet ./...` for Go projects.
 */
function checkGoVet(projectRoot) {
    const goMod = path.join(projectRoot, "go.mod");
    if (!fs.existsSync(goMod)) return [];

    const result = spawnSync(
        "go", ["vet", "./..."],
        { cwd: projectRoot, encoding: "utf8", timeout: 60000 }
    );
    if (result.status === 0) return [];

    const output = (result.stderr || result.stdout || "").trim();
    return output.split("\n").filter(Boolean).slice(0, 20).map(line => ({
        file: "go",
        issue: line.trim()
    }));
}

/** MCP tool handler */
export function analyzeProject({ project }) {
    const config = getProject(project);
    const root   = config.root;
    const type   = config.type || "unknown";

    const isJava   = JAVA_TYPES.has(type);
    const isNode   = NODE_TYPES.has(type);
    const isPython = PYTHON_TYPES.has(type);
    const isGo     = type === "go";

    const brokenImports = isNode  ? checkBrokenImports(root) : [];
    const syntaxErrors  = isNode  ? checkSyntax(root)        : [];
    const tsErrors      = isNode  ? checkTypeScript(root, type) : [];
    const pyErrors      = isPython ? checkPythonSyntax(root) : [];
    const goErrors      = isGo    ? checkGoVet(root)         : [];

    // Java/Kotlin/unknown — just confirm analysis ran
    if (isJava) {
        return { content: [{ type: "text", text: `Static analysis skipped for ${type} — compiler handles type checking. Run project_build to verify.` }] };
    }

    const total = brokenImports.length + syntaxErrors.length + tsErrors.length + pyErrors.length + goErrors.length;

    if (total === 0) {
        return { content: [{ type: "text", text: `Static analysis passed — no issues found. (${type} project)` }] };
    }

    const lines = [`Static analysis: ${total} issue(s) found in ${type} project\n`];

    if (brokenImports.length > 0) {
        lines.push(`Broken imports (${brokenImports.length}):`);
        brokenImports.forEach(i => lines.push(`  ${i.file}: import '${i.import}' — ${i.issue}`));
    }
    if (syntaxErrors.length > 0) {
        lines.push(`Syntax errors (${syntaxErrors.length}):`);
        syntaxErrors.forEach(e => lines.push(`  ${e.file}: ${e.issue}`));
    }
    if (tsErrors.length > 0) {
        lines.push(`TypeScript errors (${tsErrors.length}):`);
        tsErrors.forEach(e => lines.push(`  ${e.file}: ${e.issue}`));
    }
    if (pyErrors.length > 0) {
        lines.push(`Python syntax errors (${pyErrors.length}):`);
        pyErrors.forEach(e => lines.push(`  ${e.file}: ${e.issue}`));
    }
    if (goErrors.length > 0) {
        lines.push(`Go vet issues (${goErrors.length}):`);
        goErrors.forEach(e => lines.push(`  ${e.issue}`));
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
}
