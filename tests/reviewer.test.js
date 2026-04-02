/**
 * tests/reviewer.test.js
 *
 * Tests for the reviewer agent budget gating, skip conditions, and
 * parse-error fallback — all without calling Ollama (fully mocked).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ollamaClient before importing reviewer
vi.mock("../src/agent/ollamaClient.js", () => ({
    askLLM: vi.fn()
}));

import { askLLM } from "../src/agent/ollamaClient.js";
import { reviewChanges } from "../src/agent/reviewer.js";
import { makeExecutionState } from "../src/agent/executionState.js";

function makeState(modifiedFiles = [], errors = []) {
    const s = makeExecutionState();
    modifiedFiles.forEach(f => {
        s.recordToolCall("project_str_replace",
            { edits: [{ path: f, search: "a", replace: "b" }] }, "ok", 1);
    });
    return s;
}

function makeCost(calls = 0) {
    return { llmCalls: calls, totalChars: 0 };
}

describe("reviewChanges", () => {

    beforeEach(() => { vi.clearAllMocks(); });

    it("skips when no files were modified", async () => {
        const result = await reviewChanges(
            "proj", "fix bug", makeState([]), makeCost(0), ""
        );
        expect(result.verdict).toBe("skipped");
        expect(askLLM).not.toHaveBeenCalled();
    });

    it("skips in final mode when fewer than 2 LLM calls remain", async () => {
        // MAX_LLM_CALLS_PER_RUN = 30, so llmCalls=29 leaves 1 remaining < 2
        const result = await reviewChanges(
            "proj", "fix bug", makeState(["src/foo.js"]), makeCost(29), ""
        );
        expect(result.verdict).toBe("skipped");
        expect(askLLM).not.toHaveBeenCalled();
    });

    it("skips in early mode when fewer than 4 LLM calls remain", async () => {
        // llmCalls=27 leaves 3 remaining < 4
        const result = await reviewChanges(
            "proj", "fix bug", makeState(["src/foo.js"]), makeCost(27), "", true
        );
        expect(result.verdict).toBe("skipped");
        expect(askLLM).not.toHaveBeenCalled();
    });

    it("calls LLM and returns parsed verdict when budget allows", async () => {
        askLLM.mockResolvedValue('{"verdict":"correct","issues":[],"confident":true}');
        const result = await reviewChanges(
            "proj", "fix login bug", makeState(["src/auth.js"]), makeCost(0), "context"
        );
        expect(result.verdict).toBe("correct");
        expect(result.confident).toBe(true);
        expect(result.issues).toEqual([]);
        expect(askLLM).toHaveBeenCalledOnce();
    });

    it("returns issues array when LLM finds problems", async () => {
        askLLM.mockResolvedValue('{"verdict":"has_issues","issues":["Missing null check","Import path wrong"],"confident":true}');
        const result = await reviewChanges(
            "proj", "add feature", makeState(["src/api.js"]), makeCost(0), ""
        );
        expect(result.verdict).toBe("has_issues");
        expect(result.issues).toHaveLength(2);
        expect(result.issues[0]).toContain("null check");
    });

    it("returns unknown verdict on LLM parse failure", async () => {
        askLLM.mockResolvedValue("not json at all");
        const result = await reviewChanges(
            "proj", "fix bug", makeState(["src/x.js"]), makeCost(0), ""
        );
        expect(result.verdict).toBe("unknown");
        expect(result.issues).toEqual([]);
    });

    it("increments llmCalls on each invocation", async () => {
        askLLM.mockResolvedValue('{"verdict":"correct","issues":[],"confident":true}');
        const cost = makeCost(5);
        await reviewChanges("proj", "fix", makeState(["src/a.js"]), cost, "");
        expect(cost.llmCalls).toBe(6);
    });

    it("reviewer fires for single-file changes (threshold = 1)", async () => {
        // Validates the threshold fix from Round 1
        askLLM.mockResolvedValue('{"verdict":"likely_correct","issues":[],"confident":false}');
        const result = await reviewChanges(
            "proj", "patch one file", makeState(["src/single.js"]), makeCost(0), ""
        );
        expect(result.verdict).toBe("likely_correct");
        expect(askLLM).toHaveBeenCalledOnce();
    });
});
