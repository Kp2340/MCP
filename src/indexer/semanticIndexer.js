import fs from "fs";
import path from "path";
import { getParser } from "./languageLoader.js";
import { IGNORE_FOLDERS } from "../core/constants.js";

export function buildSemanticIndex(projectRoot) {
    const index = { classes: [], functions: [] };

    function scanNode(node, file) {
        // FIX: use childForFieldName('name') — not firstChild which is the keyword
        if (node.type === "class_declaration" || node.type === "class_definition") {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                index.classes.push({ name: nameNode.text, file });
            }
        }

        if (
            node.type === "function_declaration" ||
            node.type === "method_definition" ||
            node.type === "arrow_function" ||
            node.type === "function_expression"
        ) {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                index.functions.push({ name: nameNode.text, file });
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
            // FIX: skip ignored folders — was missing before (indexed node_modules)
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
                const source = fs.readFileSync(full, "utf8");
                const tree = parser.parse(source);
                const relPath = path.relative(projectRoot, full);
                scanNode(tree.rootNode, relPath);
            } catch {
                // Parse error on this file — skip
            }
        }
    }

    walk(projectRoot);
    return index;
}