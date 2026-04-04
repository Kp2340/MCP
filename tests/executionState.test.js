import { describe, it, expect } from "vitest";
import { classifyFailure, makeExecutionState } from "../src/agent/executionState.js";

describe("classifyFailure", () => {
    it("classifies Node.js import errors", () => {
        expect(classifyFailure("Error: Cannot find module 'express'")).toBe("import_error");
    });

    it("classifies TypeScript import errors", () => {
        expect(classifyFailure("Module '\"./foo\"' has no exported member 'Bar'")).toBe("import_error");
    });

    it("classifies syntax errors", () => {
        expect(classifyFailure("SyntaxError: Unexpected token ')'")).toBe("syntax_error");
    });

    it("classifies build failures", () => {
        expect(classifyFailure("BUILD FAILED: compilation error in Foo.java")).toBe("build_failure");
    });

    it("classifies runtime TypeErrors", () => {
        expect(classifyFailure("TypeError: Cannot read properties of undefined")).toBe("runtime_error");
    });

    it("classifies not-found errors", () => {
        expect(classifyFailure("File does not exist: src/missing.js")).toBe("not_found");
    });

    it("classifies permission errors", () => {
        expect(classifyFailure("EACCES: permission denied")).toBe("permission_error");
    });

    it("returns unknown_error for unclassified failure signals", () => {
        expect(classifyFailure("Something went wrong with the error process")).toBe("unknown_error");
    });

    it("returns null for clean output", () => {
        expect(classifyFailure("Build successful. 3 files compiled.")).toBeNull();
        expect(classifyFailure("")).toBeNull();
        expect(classifyFailure(null)).toBeNull();
    });
});

describe("ExecutionState", () => {
    it("tracks files read", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_read_files", { paths: ["src/foo.js"] }, "", 1);
        expect(state.hasRead("src/foo.js")).toBe(true);
        expect(state.hasRead("src/bar.js")).toBe(false);
    });

    it("normalises Windows paths to forward slashes", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_read_files", { paths: ["src\\foo.js"] }, "", 1);
        expect(state.hasRead("src/foo.js")).toBe(true);
    });

    it("tracks files modified via str_replace", () => {
        const state = makeExecutionState();
        state.recordToolCall(
            "project_str_replace",
            { edits: [{ path: "src/bar.js", search: "x", replace: "y" }] },
            "", 1
        );
        expect(state.hasModified("src/bar.js")).toBe(true);
        expect(state.hasRead("src/bar.js")).toBe(true);   // modified implies read
    });

    it("classifies and records errors from tool results", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_build", {}, "BUILD FAILED: error in Foo.java", 2);
        expect(state.lastError()).not.toBeNull();
        expect(state.lastError().type).toBe("build_failure");
    });

    it("returns null lastError when no errors occurred", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_scan", {}, "OK", 1);
        expect(state.lastError()).toBeNull();
    });

    it("caches idempotent read results", () => {
        const state = makeExecutionState();
        const args  = { project: "jsv", paths: ["src/foo.js"] };
        state.recordToolCall("project_read_files", args, "file content", 1);
        expect(state.getCachedResult("project_read_files", args)).toBe("file content");
    });

    it("assigns a unique traceId to each run", () => {
        const s1 = makeExecutionState();
        const s2 = makeExecutionState();
        expect(typeof s1.traceId).toBe("string");
        expect(s1.traceId.length).toBeGreaterThan(0);
        expect(s1.traceId).not.toBe(s2.traceId);
    });

    it("increments idleSteps when no file changes or new errors occur", () => {
        const state = makeExecutionState();
        // read-only step: no file modification, no error
        state.recordToolCall("project_scan", {}, "OK", 1);
        expect(state.idleSteps).toBe(1);
        state.recordToolCall("project_scan", {}, "OK", 2);
        expect(state.idleSteps).toBe(2);
    });

    it("resets idleSteps to 0 when a file is modified", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_scan", {}, "OK", 1);  // idle
        expect(state.idleSteps).toBe(1);
        state.recordToolCall(
            "project_str_replace",
            { edits: [{ path: "src/x.js", search: "a", replace: "b" }] },
            "ok", 2
        );
        expect(state.idleSteps).toBe(0);  // progress made
    });

    it("resets idleSteps to 0 when a new error is recorded", () => {
        const state = makeExecutionState();
        state.recordToolCall("project_scan", {}, "OK", 1);  // idle
        expect(state.idleSteps).toBe(1);
        state.recordToolCall("project_build", {}, "BUILD FAILED", 2);  // new error
        expect(state.idleSteps).toBe(0);
    });
});
