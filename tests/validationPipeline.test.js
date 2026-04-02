/**
 * tests/validationPipeline.test.js
 *
 * Tests for the unified validation pipeline:
 *   - heuristic check (goalValidator)
 *   - build check (mocked mcpClient)
 *   - reviewer integration
 *   - issuesAsSteps conversion
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/agent/ollamaClient.js", () => ({
    askLLM: vi.fn()
}));

import { askLLM } from "../src/agent/ollamaClient.js";
import { runValidationPipeline, issuesAsSteps } from "../src/agent/validationPipeline.js";
import { makeExecutionState } from "../src/agent/executionState.js";

function makeCost(calls = 0) { return { llmCalls: calls, totalChars: 0 }; }

function makeMcpClient(analyzeText = "Static analysis passed") {
    return {
        callTool: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: analyzeText }]
        })
    };
}

function stateWithMod(files = []) {
    const s = makeExecutionState();
    files.forEach(f =>
        s.recordToolCall("project_str_replace",
            { edits: [{ path: f, search: "x", replace: "y" }] }, "ok", 1)
    );
    return s;
}

describe("runValidationPipeline", () => {

    beforeEach(() => { vi.clearAllMocks(); });

    it("passes heuristic when at least one tool was used (general intent)", async () => {
        const s = makeExecutionState();
        s.recordToolCall("project_scan", {}, "ok", 1);
        const result = await runValidationPipeline(
            "general", "proj", s, makeCost(), makeMcpClient(), "list files", ""
        );
        // general intent + tool was used + analysis passed → should pass
        expect(result.passed).toBe(true);
        expect(result.reviewer).toBeNull();
    });

    it("calls reviewer when 1 file is modified (threshold fix)", async () => {
        askLLM.mockResolvedValue('{"verdict":"correct","issues":[],"confident":true}');
        const result = await runValidationPipeline(
            "fix", "proj",
            stateWithMod(["src/auth.js"]),
            makeCost(0),
            makeMcpClient(),
            "fix login bug",
            "did stuff"
        );
        expect(result.reviewer).not.toBeNull();
        expect(result.reviewer.verdict).toBe("correct");
    });

    it("collects reviewer issues into result.issues", async () => {
        askLLM.mockResolvedValue('{"verdict":"has_issues","issues":["Missing semicolon"],"confident":true}');
        const result = await runValidationPipeline(
            "api", "proj",
            stateWithMod(["src/routes.js"]),
            makeCost(0),
            makeMcpClient(),
            "add route",
            ""
        );
        expect(result.issues).toContain("Missing semicolon");
    });

    it("marks failed when build analysis reports errors", async () => {
        const result = await runValidationPipeline(
            "fix", "proj",
            makeExecutionState(),
            makeCost(),
            makeMcpClient("Static analysis: 3 issue(s) found — error in src/main.js"),
            "fix crash",
            ""
        );
        expect(result.build.passed).toBe(false);
        expect(result.passed).toBe(false);
    });
});

describe("issuesAsSteps", () => {
    it("converts issues to injectable step strings", () => {
        const steps = issuesAsSteps(["Missing null check", "Wrong import path"]);
        expect(steps).toHaveLength(2);
        expect(steps[0]).toContain("Fix reviewer issue");
        expect(steps[0]).toContain("Missing null check");
    });

    it("caps at 3 steps", () => {
        const steps = issuesAsSteps(["a", "b", "c", "d", "e"]);
        expect(steps).toHaveLength(3);
    });

    it("returns empty array for empty issues", () => {
        expect(issuesAsSteps([])).toEqual([]);
    });
});
