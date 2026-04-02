/**
 * tests/goalValidator.test.js
 *
 * Tests for goalValidator intent-based pass/fail logic.
 */

import { describe, it, expect, vi } from "vitest";
import { validateGoal } from "../src/agent/goalValidator.js";
import { makeExecutionState } from "../src/agent/executionState.js";

function stateWithMod(files) {
    const s = makeExecutionState();
    files.forEach(f =>
        s.recordToolCall("project_str_replace",
            { edits: [{ path: f, search: "x", replace: "y" }] }, "ok", 1)
    );
    return s;
}

function stateWithError(errorText, step = 1) {
    const s = makeExecutionState();
    s.recordToolCall("project_build", {}, errorText, step);
    return s;
}

describe("validateGoal — fix intent", () => {
    it("passes when no errors remain", () => {
        const result = validateGoal("fix", stateWithMod(["src/foo.js"]));
        expect(result.passed).toBe(true);
    });

    it("fails when last error is unresolved at the final step", () => {
        const s = makeExecutionState();
        // Error at step 5, no later steps
        s.recordToolCall("project_build", {}, "BUILD FAILED: error in Foo.java", 5);
        s.stepCount = 5;
        const result = validateGoal("fix", s);
        expect(result.passed).toBe(false);
        expect(result.reason).toContain("build_failure");
    });

    it("passes when error occurred early but later steps ran", () => {
        const s = makeExecutionState();
        s.recordToolCall("project_build", {}, "BUILD FAILED", 2);
        s.stepCount = 8;  // 6 more steps ran after the error
        const result = validateGoal("fix", s);
        expect(result.passed).toBe(true);
    });
});

describe("validateGoal — api intent", () => {
    it("fails when no files were modified", () => {
        const result = validateGoal("api", makeExecutionState());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain("No files were modified");
    });

    it("passes when at least one file is modified", () => {
        const result = validateGoal("api", stateWithMod(["src/routes/user.js"]));
        expect(result.passed).toBe(true);
    });
});

describe("validateGoal — ui intent", () => {
    it("fails when only non-UI files modified", () => {
        const result = validateGoal("ui", stateWithMod(["src/utils/config.js"]));
        expect(result.passed).toBe(false);
    });

    it("passes for .jsx files", () => {
        const result = validateGoal("ui", stateWithMod(["src/components/Header.jsx"]));
        expect(result.passed).toBe(true);
    });

    it("passes for files with 'component' in name", () => {
        const result = validateGoal("ui", stateWithMod(["src/MyComponent.js"]));
        expect(result.passed).toBe(true);
    });
});

describe("validateGoal — general intent", () => {
    it("passes when tools were used", () => {
        const s = makeExecutionState();
        s.recordToolCall("project_scan", {}, "ok", 1);
        const result = validateGoal("general", s);
        expect(result.passed).toBe(true);
    });

    it("fails when no tools were used", () => {
        const result = validateGoal("general", makeExecutionState());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain("No tools were executed");
    });
});
