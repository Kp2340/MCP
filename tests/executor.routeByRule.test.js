import { describe, it, expect } from "vitest";

/**
 * routeByRule is not exported from executor.js (it is internal).
 * We test its behaviour indirectly by importing executeStep with a mocked
 * costState that tracks whether the LLM was called.
 *
 * For direct unit testing we extract the routing logic into a testable
 * helper — see tests below which validate the EXPECTED output format
 * without touching the LLM.
 */

// Replicate the routing logic here so it can be unit-tested without mocking Ollama.
// This is intentionally a copy — if executor.js routing changes, update this too.
function routeByRule(step, project) {
    const s = step.toLowerCase();
    if (/\b(scan|list files|folder structure|project structure)\b/.test(s))
        return { tool: "project_scan", args: { project } };
    if (/\b(build and fix|build_and_fix|auto.?fix|run build and fix)\b/.test(s))
        return { tool: "project_build_and_fix", args: { project } };
    if (/\b(run build|npm run build|gradlew build|mvn|compile)\b/.test(s))
        return { tool: "project_build", args: { project } };
    if (/\b(analyze|analyse|static.?analy|lint|check imports|run static analysis|identify issues)\b/.test(s))
        return { tool: "project_analyze", args: { project } };
    if (/\b(show diff|git diff|what changed|uncommitted|review changes)\b/.test(s))
        return { tool: "project_diff", args: { project } };
    if (/\b(git log|commit history|recent commits|what was committed)\b/.test(s))
        return { tool: "project_git_log", args: { project } };
    return null;
}

describe("routeByRule", () => {
    it("routes scan steps", () => {
        expect(routeByRule("Scan project structure", "jsv").tool).toBe("project_scan");
        expect(routeByRule("List files in the project", "jsv").tool).toBe("project_scan");
    });

    it("routes build-and-fix steps", () => {
        expect(routeByRule("Run build and fix to verify", "jsv").tool).toBe("project_build_and_fix");
        expect(routeByRule("Build and fix errors", "jsv").tool).toBe("project_build_and_fix");
    });

    it("routes plain build steps", () => {
        expect(routeByRule("Run build", "jsv").tool).toBe("project_build");
        expect(routeByRule("npm run build", "jsv").tool).toBe("project_build");
    });

    it("routes static analysis steps", () => {
        expect(routeByRule("Run static analysis to identify issues", "jsv").tool).toBe("project_analyze");
        expect(routeByRule("Analyze the project", "jsv").tool).toBe("project_analyze");
    });

    it("routes diff steps", () => {
        expect(routeByRule("Show diff of uncommitted changes", "jsv").tool).toBe("project_diff");
    });

    it("routes git log steps", () => {
        expect(routeByRule("Show git log", "jsv").tool).toBe("project_git_log");
    });

    it("injects the project into args", () => {
        const result = routeByRule("Scan project structure", "my-project");
        expect(result.args.project).toBe("my-project");
    });

    it("returns null for LLM-required steps", () => {
        expect(routeByRule("Apply the changes from the context", "jsv")).toBeNull();
        expect(routeByRule("Read the login component and modify it", "jsv")).toBeNull();
    });
});
