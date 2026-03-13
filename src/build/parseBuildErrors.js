/**
 * Parse build output into a list of concise error strings.
 * Handles output from: npm/vite, gradle, maven, tsc.
 */
export function parseErrors(output) {
    if (!output) return [];

    const lines = output.split("\n");
    const errors = [];

    for (const line of lines) {
        const l = line.trim();
        if (!l) continue;

        // TypeScript / ESBuild / Vite
        if (l.match(/error TS\d+/i)) { errors.push(l); continue; }
        // Java / Gradle / Maven
        if (l.match(/^\[ERROR\]|error:|ERROR:/)) { errors.push(l); continue; }
        // General "error" lines (avoid warnings)
        if (l.toLowerCase().includes("error") && !l.toLowerCase().includes("warning")) {
            if (l.length < 300) errors.push(l);
        }
    }

    // Deduplicate
    return [...new Set(errors)].slice(0, 30);
}
