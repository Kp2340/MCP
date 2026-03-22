/**
 * src/tools/projectTest.js
 *
 * project_test — run the project's test suite and return structured results.
 *
 * Supports: npm test, vitest, jest, mvn test, gradle test, pytest, go test.
 * Returns: { passed, failed, total, output } so the agent and IDE can act on it.
 */

import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { createLogger } from "../core/logger.js";

const log             = createLogger("test");
const TEST_TIMEOUT_MS = 120_000;

// Per-project-type test commands
const TEST_COMMANDS = {
    nextjs:       ["npm",  ["test",  "--",  "--watchAll=false",  "--passWithNoTests"]],
    "react-vite": ["npm",  ["run",   "test"]],
    nodejs:       ["npm",  ["test"]],
    "spring-boot":["./mvnw", ["test",  "-q"]],
    gradle:       ["./gradlew", ["test"]],
    django:       ["python", ["-m",  "pytest",  "-q"]],
    python:       ["python", ["-m",  "pytest",  "-q"]],
    go:           ["go",   ["test",  "./..."]],
    rust:         ["cargo", ["test",  "--quiet"]],
    rails:        ["bundle", ["exec",  "rails",  "test"]],
};

// Parse common test result lines from output
function parseResults(output) {
    // Jest / vitest: "Tests: 3 failed, 12 passed, 15 total"
    const jestMatch = output.match(/(\d+) failed.*?(\d+) passed.*?(\d+) total/i)
        || output.match(/Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (jestMatch) return { failed: +jestMatch[1], passed: +jestMatch[2], total: +jestMatch[3] };

    // Pytest: "5 passed, 1 failed"
    const pytestMatch = output.match(/(\d+) passed(?:,\s*(\d+) failed)?/i);
    if (pytestMatch) return { passed: +pytestMatch[1], failed: +(pytestMatch[2] || 0), total: +pytestMatch[1] + +(pytestMatch[2] || 0) };

    // Maven/Gradle: "Tests run: 10, Failures: 2, Errors: 0"
    const mavenMatch = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+)/i);
    if (mavenMatch) return { total: +mavenMatch[1], failed: +mavenMatch[2], passed: +mavenMatch[1] - +mavenMatch[2] };

    // Go: "PASS" or "FAIL"
    if (/^ok\s/m.test(output))  return { passed: 1, failed: 0, total: 1 };
    if (/^FAIL\s/m.test(output)) return { passed: 0, failed: 1, total: 1 };

    return null;
}

export async function testProject({ project }) {
    const config = getProject(project);

    // Determine test command
    let cmd, args;
    if (config.testCommand && config.testCommand.trim()) {
        // Custom test command from project config
        const parts = config.testCommand.trim().split(/\s+/);
        cmd  = parts[0];
        args = parts.slice(1);
    } else {
        const entry = TEST_COMMANDS[config.type];
        if (!entry) {
            return {
                content: [{ type: "text", text: `TEST SKIPPED — no test command known for project type "${config.type}". Add testCommand to projects.json.` }],
                success: true
            };
        }
        [cmd, args] = entry;
    }

    log.info(`Running tests for "${project}" | cmd: ${cmd} ${args.join(" ")}`);

    // On Windows, npm/npx are .cmd scripts and need shell:true to be found.
    // On Linux/macOS shell:true is harmless. We use it unconditionally to keep
    // the code simple — args are all static constants, no user input injected.
    const needsShell = process.platform === "win32" || cmd === "npm" || cmd === "npx";

    const result = spawnSync(cmd, args, {
        cwd:       config.root,
        encoding:  "utf-8",
        timeout:   TEST_TIMEOUT_MS,
        shell:     needsShell,
        env:       { ...process.env, CI: "true", FORCE_COLOR: "0" },
        maxBuffer: 10 * 1024 * 1024  // 10 MB — vitest verbose output can be large
    });

    // Combine stdout + stderr; if both empty, show the spawn error
    const stdout   = (result.stdout || "").trim();
    const stderr   = (result.stderr || "").trim();
    const spawnErr = result.error ? `Spawn error: ${result.error.message}` : "";
    const output   = [stdout, stderr, spawnErr].filter(Boolean).join("");
    const exitCode = result.status ?? 1;
    const timedOut = result.error?.code === "ETIMEDOUT";

    if (timedOut) {
        return {
            content: [{ type: "text", text: `TEST TIMEOUT after ${TEST_TIMEOUT_MS / 1000}s` }],
            success: false
        };
    }

    const parsed  = parseResults(output);
    const success = exitCode === 0;
    const summary = success ? "TEST PASSED" : `TEST FAILED (exit ${exitCode})`;

    const structured = parsed
        ? `${summary} — passed: ${parsed.passed}, failed: ${parsed.failed}, total: ${parsed.total}`
        : summary;

    log.info(`Test result for "${project}": ${structured}`);

    return {
        content: [{ type: "text", text: `${structured}

${output.substring(0, 6000)}` }],
        success,
        parsed
    };
}
