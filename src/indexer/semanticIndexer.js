import fs from "fs";
import path from "path";
import { getParser } from "./languageLoader.js";
import { IGNORE_FOLDERS, INDEX_CACHE_FILE } from "../core/constants.js";

/**
 * Build a semantic index of all classes, functions, and exported arrow
 * functions in the project.
 *
 * Improvements over v1:
 *   - Arrow functions: detects `export const Foo = () => ...` and
 *     `const Foo = function() {}` patterns (dominant React pattern)
 *   - Line numbers: each entry now includes { name, file, line }
 *   - Persistent cache: writes .ai-dev-index-cache.json so project_find_symbol
 *     works instantly after MCP server restarts without a full rebuild
 */
export function buildSemanticIndex(projectRoot) {
    const index = { classes: [], functions: [] };

    function scanNode(node, file) {
        const type = node.type;

        // ─ Class declarations ───────────────────────────────────────────────
        if (type === "class_declaration" || type === "class_definition") {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                index.classes.push({
                    name: nameNode.text,
                    file,
                    line: node.startPosition.row + 1
                });
            }
        }

        // ─ Named function declarations and method definitions ───────────────
        if (
            type === "function_declaration" ||
            type === "method_definition" ||
            type === "function_expression"
        ) {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                index.functions.push({
                    name: nameNode.text,
                    file,
                    line: node.startPosition.row + 1
                });
            }
        }

        // ─ Arrow functions and function expressions assigned to variables ─────
        // Covers: export const Foo = () => ...  AND  const bar = function() {}
        // This is the dominant pattern in React/Next.js and was missing in v1.
        if (type === "variable_declarator") {
            const nameNode  = node.childForFieldName("name");
            const valueNode = node.childForFieldName("value");
            if (
                nameNode &&
                valueNode &&
                (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
            ) {
                index.functions.push({
                    name: nameNode.text,
                    file,
                    line: node.startPosition.row + 1
                });
            }
        }

        for (const child of node.children) {
            scanNode(child, file);
        }
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
            const parser = getParser(ext);
            if (!parser) continue;

            const full = path.join(dir, item.name);
            try {
                const source  = fs.readFileSync(full, "utf8");
                const tree    = parser.parse(source);
                const relPath = path.relative(projectRoot, full);
                scanNode(tree.rootNode, relPath);
            } catch {
                // Parse error on this file — skip silently
            }
        }
    }

    walk(projectRoot);

    // Persist to disk so MCP server restarts don't need a full rebuild
    const cachePath = path.join(projectRoot, INDEX_CACHE_FILE);
    try {
        fs.writeFileSync(cachePath, JSON.stringify(index), "utf8");
    } catch {
        // Non-fatal — in-memory index still works
    }

    return index;
}

/**
 * Load the persisted index from disk if available.
 * Returns null if cache is missing or corrupt.
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
