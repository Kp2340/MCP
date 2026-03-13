import fs from "fs";
import path from "path";
import { getParser } from "./languageLoader.js";

export function buildSemanticIndex(projectRoot) {

    const index = {
        classes: [],
        functions: []
    };

    function walk(dir) {

        const files = fs.readdirSync(dir);

        for (const file of files) {

            const full = path.join(dir, file);

            const stat = fs.statSync(full);

            if (stat.isDirectory()) {
                walk(full);
                continue;
            }

            const ext = path.extname(file);

            const parser = getParser(ext);

            if (!parser) continue;

            const source = fs.readFileSync(full, "utf8");

            const tree = parser.parse(source);

            scanNode(tree.rootNode, full);
        }
    }

    function scanNode(node, file) {

        if (node.type === "class_declaration") {

            index.classes.push({
                name: node.firstChild.text,
                file
            });
        }

        if (
            node.type === "function_declaration" ||
            node.type === "method_definition"
        ) {
            index.functions.push({
                name: node.firstChild.text,
                file
            });
        }

        node.children.forEach(child => scanNode(child, file));
    }

    walk(projectRoot);

    return index;
}