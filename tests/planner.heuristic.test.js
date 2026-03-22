import { describe, it, expect } from "vitest";
import { TOOL_CHAIN_TEMPLATES, KEYWORD_STEMS } from "../src/core/constants.js";

// Replicate tryHeuristicPlan for isolated unit testing (avoids importing planner
// which has side-effect imports of ollamaClient, memory, etc.)
function tryHeuristicPlan(prompt, projectType = null, retrieverIntent = null, activeErrorType = null) {
    let lower = prompt.toLowerCase();
    for (const [stem, canonical] of Object.entries(KEYWORD_STEMS)) {
        lower = lower.replace(new RegExp(`\\b${stem}\\b`, "g"), canonical);
    }
    let bestTemplate = null;
    let bestScore    = 0;
    const ERROR_INTENT_MAP = {
        import_error: "fix", syntax_error: "fix", build_failure: "fix",
        runtime_error: "fix", not_found: "fix", permission_error: "fix"
    };
    const errorImpliedIntent = activeErrorType ? ERROR_INTENT_MAP[activeErrorType] : null;
    for (const template of TOOL_CHAIN_TEMPLATES) {
        if (template.projectTypes && projectType && !template.projectTypes.includes(projectType)) continue;
        const keywordHits = template.keywords.filter(kw => lower.includes(kw)).length;
        if (keywordHits === 0) continue;
        const intentBonus = (retrieverIntent && retrieverIntent === template.intent) ? 1 : 0;
        const errorBias   = (errorImpliedIntent && template.intent === errorImpliedIntent) ? 2 : 0;
        const score = keywordHits + intentBonus + errorBias;
        if (score > bestScore) { bestScore = score; bestTemplate = template; }
    }
    return (bestScore >= 2 && bestTemplate) ? bestTemplate.steps : null;
}

describe("tryHeuristicPlan", () => {
    it("matches fix_error template for error/bug prompts", () => {
        const steps = tryHeuristicPlan("fix the login bug and error in the form");
        expect(steps).not.toBeNull();
        expect(steps.some(s => /build/i.test(s))).toBe(true);
    });

    it("matches add_api template for API requests", () => {
        const steps = tryHeuristicPlan("add a new endpoint to the user service");
        expect(steps).not.toBeNull();
    });

    it("matches ui_edit template for component prompts regardless of intent", () => {
        const steps = tryHeuristicPlan("add a copyright text to the footer", "react-vite");
        expect(steps).not.toBeNull();
    });

    it("respects projectType filter for ui templates", () => {
        // ui_edit is restricted to react-vite and nextjs — should not match spring-boot
        const steps = tryHeuristicPlan("update the footer header navbar", "spring-boot");
        // May match another template or null — must not match ui_edit
        if (steps !== null) {
            // steps should NOT come from ui_edit
            expect(steps).not.toEqual(
                TOOL_CHAIN_TEMPLATES.find(t => t.name === "ui_edit")?.steps
            );
        }
    });

    it("returns null for ambiguous single-keyword prompts", () => {
        // Only 1 keyword hit, score < 2 — should not match
        const steps = tryHeuristicPlan("fix this");
        expect(steps).toBeNull();
    });

    it("boost scores for active error type", () => {
        // build_failure implies 'fix' intent → +2 for fix templates
        const steps = tryHeuristicPlan("run fix", null, null, "build_failure");
        expect(steps).not.toBeNull();
    });

    it("normalises word stems (fixing → fix)", () => {
        const steps = tryHeuristicPlan("fixing the bug and error in the app");
        expect(steps).not.toBeNull();
    });

    it("matches add_test template", () => {
        const steps = tryHeuristicPlan("add test for the login service");
        expect(steps).not.toBeNull();
    });

    it("matches refactor template", () => {
        const steps = tryHeuristicPlan("refactor and rename the auth module");
        expect(steps).not.toBeNull();
    });
});
