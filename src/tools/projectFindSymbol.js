import { getIndex } from "./projectIndex.js";

/**
 * Find a symbol (class, function, or exported arrow function) by name.
 * Returns file path + line number for direct navigation.
 * Falls back to cached index on disk if in-memory index is missing.
 */
export function projectFindSymbol({ project, name }) {
    const index = getIndex(project);

    if (!index) {
        throw new Error("Project index not built. Run project_index first.");
    }

    const lowerName = name.toLowerCase();
    const matches   = [];

    // Case-insensitive partial match on both classes and functions
    for (const c of index.classes) {
        if (c.name.toLowerCase().includes(lowerName)) {
            matches.push({ kind: "class", name: c.name, file: c.file, line: c.line || null });
        }
    }
    for (const f of index.functions) {
        if (f.name.toLowerCase().includes(lowerName)) {
            matches.push({ kind: "function", name: f.name, file: f.file, line: f.line || null });
        }
    }

    if (matches.length === 0) {
        return {
            content: [{ type: "text", text: `No symbol matching "${name}" found in index.` }]
        };
    }

    // Format as human-readable lines for easy LLM consumption
    const lines = matches.map(m =>
        `${m.kind.padEnd(8)} ${m.name}  →  ${m.file}${m.line ? `:${m.line}` : ""}`
    );

    return {
        content: [{ type: "text", text: lines.join("\n") }]
    };
}