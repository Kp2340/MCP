/**
 * Extracts the first complete JSON object from a string that may contain
 * surrounding prose, markdown fences, or explanation text from the LLM.
 *
 * This is centralised here so executor.js, autoFixLoop.js, and any future
 * LLM callers all share the same robust parser.
 */
export function extractJSON(text) {
    if (!text) return "";

    // Strip markdown fences
    text = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    // Find the first '{' and balance-match to its closing '}'
    const start = text.indexOf("{");
    if (start === -1) return text;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (escape) { escape = false; continue; }
        if (ch === "\\" && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }

    return text.trim();
}

/**
 * Safely parse JSON from LLM output.
 * Returns { ok: true, value } or { ok: false, raw }.
 */
export function safeParse(text) {
    const extracted = extractJSON(text);
    try {
        return { ok: true, value: JSON.parse(extracted) };
    } catch {
        return { ok: false, raw: text };
    }
}
