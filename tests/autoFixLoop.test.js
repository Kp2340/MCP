/**
 * tests/autoFixLoop.test.js
 *
 * Tests the autoFixLoop's integration with classifyFailure and the build
 * success / immediate-exit path. Deep mocking of the full chain is avoided
 * by testing the pure logic units that autoFixLoop delegates to.
 */

import { describe, it, expect } from "vitest";
import { classifyFailure } from "../src/agent/executionState.js";

// These tests verify the error classification that autoFixLoop uses to
// decide between deterministic recovery (0 LLM) vs LLM fallback.
// Full integration tests require Ollama + filesystem — covered manually.

describe("autoFixLoop error classification (via classifyFailure)", () => {

    it("classifies syntax errors for deterministic recovery", () => {
        expect(classifyFailure("SyntaxError: Unexpected token '}'")).toBe("syntax_error");
    });

    it("classifies import errors for deterministic recovery", () => {
        expect(classifyFailure("Error: Cannot find module 'lodash'")).toBe("import_error");
    });

    it("classifies build failures for deterministic recovery", () => {
        expect(classifyFailure("BUILD FAILED: 3 errors in compilation")).toBe("build_failure");
    });

    it("returns null (clean) when build output has no failure signals", () => {
        // Must not contain any of the signal keywords (error/fail/exception/not found etc.)
        expect(classifyFailure("Build successful. All tasks passed.")).toBeNull();
    });

    it("returns unknown_error for unrecognised failure text", () => {
        // Contains a failure signal keyword ("failed") but matches no specific FAILURE_PATTERNS regex,
        // so classifyFailure falls through to the 'unknown_error' catch-all.
        expect(classifyFailure("Operation failed: unspecified reason")).toBe("unknown_error");
    });

    it("null input is treated as clean output", () => {
        expect(classifyFailure(null)).toBeNull();
    });

    it("all deterministic recovery types are defined in FAILURE_PATTERNS", () => {
        // Verify each error type the autoFixLoop branches on can be classified
        const fixtures = [
            ["Cannot find module 'x'",        "import_error"],
            ["SyntaxError: Unexpected token",  "syntax_error"],
            ["BUILD FAILED",                   "build_failure"],
            ["TypeError: Cannot read prop",    "runtime_error"],
            ["File does not exist: src/x.js",  "not_found"],
            ["EACCES: permission denied",      "permission_error"]
        ];
        for (const [text, expected] of fixtures) {
            expect(classifyFailure(text), `should classify: ${text}`).toBe(expected);
        }
    });
});
