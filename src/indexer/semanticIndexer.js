import fs from "fs";
import path from "path";
import { IGNORE_FOLDERS, INDEXABLE_EXTENSIONS, INDEX_CACHE_FILE } from "../core/constants.js";

/**
 * Regex-based semantic indexer.
 * Replaces tree-sitter to avoid native module version conflicts.
 * Detects: classes, functions, arrow functions, React components.
 */
export function buildSemanticIndex(projectRoot) {
    const index = { classes: [], functions: [] };

    // Patterns to detect symbols
    const patterns = [
        // class Foo  /  class Foo extends Bar
        { kind: "class",    re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][\w]*)/ },
        // function foo(  /  export function Foo(
        { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w]+)\s*\(/ },
        // export default function Foo(
        { kind: "function", re: /^\s*export\s+default\s+(?:async\s+)?function\s+([\w]+)\s*\(/ },
        // const Foo = () =>  /  const foo = async () =>
        { kind: "function", re: /^\s*(?:export\s+)?const\s+([\w]+)\s*=\s*(?:async\s+)?\(/ },
        // const Foo = function(
        { kind: "function", re: /^\s*(?:export\s+)?const\s+([\w]+)\s*=\s*(?:async\s+)?function/ },
        // Java/Kotlin: public class Foo
        { kind: "class",    re: /^\s*(?:public|private|protected|internal)?\s*(?:data\s+)?class\s+([A-Z][\w]*)/ },
        // Java: public void foo(  /  public String getFoo(
        { kind: "function", re: /^\s*(?:public|private|protected|static|async|override|suspend)[\w\s]*\s+([\w]+)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]?]+)?\s*\{/ },
    ];

    function scanFile(fullPath, relPath) {
        let source;
        try {
            source = fs.readFileSync(fullPath, "utf8");
        } catch {
            return;
        }

        const lines = source.split(/\r?\n/);
        lines.forEach((line, i) => {
            for (const { kind, re } of patterns) {
                const m = line.match(re);
                if (m && m[1] && m[1].length > 1) {
                    const entry = { name: m[1], file: relPath, line: i + 1 };
                    if (kind === "class") index.classes.push(entry);
                    else                  index.functions.push(entry);
                    break; // one match per line
                }
            }
        });
    }

    function walk(dir) {
        let items;
        try {
            items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const item of items) {
            if (item.isDirectory()) {
                if (IGNORE_FOLDERS.includes(item.name)) continue;
                walk(path.join(dir, item.name));
                continue;
            }

            const ext = path.extname(item.name);
            if (!INDEXABLE_EXTENSIONS.includes(ext)) continue;

            const full    = path.join(dir, item.name);
            const relPath = path.relative(projectRoot, full);
            scanFile(full, relPath);
        }
    }

    walk(projectRoot);

    // Persist to disk
    const cachePath = path.join(projectRoot, INDEX_CACHE_FILE);
    try {
        fs.writeFileSync(cachePath, JSON.stringify(index), "utf8");
    } catch {
        // Non-fatal
    }

    return index;
}

/**
 * Load the persisted index from disk if available.
 */
export function loadCachedIndex(projectRoot) {
    const cachePath = path.join(projectRoot, INDEX_CACHE_FILE);
    try {
        if (!fs.existsSync(cachePath)) return null;
        return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
        return null;
    }
}
