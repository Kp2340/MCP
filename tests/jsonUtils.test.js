import { describe, it, expect } from "vitest";
import { extractJSON, safeParse } from "../src/utils/jsonUtils.js";

describe("extractJSON", () => {
    it("extracts a plain JSON object", () => {
        const result = extractJSON('{ "tool": "project_scan", "args": {} }');
        expect(result).toBe('{ "tool": "project_scan", "args": {} }');
    });

    it("strips markdown fences", () => {
        const input = '```json\n{ "tool": "project_search" }\n```';
        const result = extractJSON(input);
        expect(result).toContain('"tool": "project_search"');
    });

    it("extracts JSON from surrounding prose", () => {
        const input = 'Here is the tool call: { "tool": "project_read_files", "args": { "paths": ["foo.js"] } } done.';
        const result = extractJSON(input);
        expect(result).toContain('"tool": "project_read_files"');
    });

    it("handles nested objects", () => {
        const input = '{ "tool": "project_str_replace", "args": { "edits": [{ "path": "a.js", "search": "x", "replace": "y" }] } }';
        const parsed = JSON.parse(extractJSON(input));
        expect(parsed.args.edits[0].path).toBe("a.js");
    });

    it("fixes invalid LLM escape sequences", () => {
        const input = '{ "regex": "\\S+@\\S+" }';
        const result = extractJSON(input);
        expect(() => JSON.parse(result)).not.toThrow();
    });

    it("returns empty string for null input", () => {
        expect(extractJSON(null)).toBe("");
        expect(extractJSON("")).toBe("");
    });

    it("returns text as-is when no JSON object found", () => {
        const result = extractJSON("no json here");
        expect(result).toBe("no json here");
    });
});

describe("safeParse", () => {
    it("returns ok=true and parsed value for valid JSON text", () => {
        const { ok, value } = safeParse('{ "tool": "project_scan" }');
        expect(ok).toBe(true);
        expect(value.tool).toBe("project_scan");
    });

    it("returns ok=false for invalid text", () => {
        const { ok, raw } = safeParse("not json at all");
        expect(ok).toBe(false);
        expect(raw).toBe("not json at all");
    });

    it("handles LLM prose wrapping", () => {
        const { ok, value } = safeParse('Sure! Here: { "tool": "project_build", "args": {} }');
        expect(ok).toBe(true);
        expect(value.tool).toBe("project_build");
    });
});
