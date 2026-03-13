import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import Java from "tree-sitter-java";

// Cache parser instances — creating a new Parser per file is expensive
const parsers = {};

export function getParser(ext) {
    if (parsers[ext]) return parsers[ext];

    const parser = new Parser();

    if (ext === ".js" || ext === ".jsx") {
        parser.setLanguage(JavaScript);
    } else if (ext === ".ts") {
        parser.setLanguage(TypeScript.typescript);
    } else if (ext === ".tsx") {
        parser.setLanguage(TypeScript.tsx);
    } else if (ext === ".java") {
        parser.setLanguage(Java);
    } else {
        return null;
    }

    parsers[ext] = parser;
    return parser;
}
