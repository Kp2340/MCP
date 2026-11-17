/**
 * src/tools/projectTest.js
 *
 * project_test — run the project's test suite and return structured results.
 *
 * Supports: npm test, vitest, jest, mvn test, gradle test, pytest, go test.
 * Returns pass/fail counts so the agent and IDE can act on results.
 */

import fs from "fs";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { createLogger } from "../core/logger.js";

const log             = createLogger("test");
const TEST_TIMEOUT_MS = 120_000;
const NL              = "\n";

// Per-project-type test commands
const TEST_COMMANDS = {
    nextjs:           ["npm",        ["test", "--", "--watchAll=false", "--passWithNoTests"]],
    "react-vite":    ["npm",        ["run", "test"]],
    nodejs:           ["npm",        ["test"]],
    "spring-boot":   ["./mvnw",     ["test", "-q"]],
    gradle:           ["./gradlew",  ["test"]],
    django:           ["python",     ["-m", "pytest", "-q"]],
    python:           ["python",     ["-m", "pytest", "-q"]],
    go:               ["go",         ["test", "./..."]],
    rust:             ["cargo",      ["test", "--quiet"]],
    rails:            ["bundle",     ["exec", "rails", "test"]],
};

function parseResults(output) {
    // Jest / vitest: "Tests: 3 failed, 12 passed, 15 total"
    const jestMatch = output.match(/(\d+) failed.*?(\d+) passed.*?(\d+) total/i)
        || output.match(/Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (jestMatch) return { failed: +jestMatch[1], passed: +jestMatch[2], total: +jestMatch[3] };

    // Vitest alternative: "\u2713 5 passed" / "\u00d7 2 failed"
    const vitestPass = output.match(/(\d+)\s+passed/i);
    const vitestFail = output.match(/(\d+)\s+failed/i);
    if (vitestPass || vitestFail) {
        const passed = vitestPass ? +vitestPass[1] : 0;
        const failed = vitestFail ? +vitestFail[1] : 0;
        return { passed, failed, total: passed + failed };
    }

    // Pytest: "5 passed, 1 failed"
    const pytestMatch = output.match(/(\d+) passed(?:,\s*(\d+) failed)?/i);
    if (pytestMatch) {
        const passed = +pytestMatch[1];
        const failed = +(pytestMatch[2] || 0);
        return { passed, failed, total: passed + failed };
    }

    // Maven/Gradle: "Tests run: 10, Failures: 2"
    const mavenMatch = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+)/i);
    if (mavenMatch) {
        const total  = +mavenMatch[1];
        const failed = +mavenMatch[2];
        return { total, failed, passed: total - failed };
    }

    // Go
    if (/^ok\s/m.test(output))   return { passed: 1, failed: 0, total: 1 };
    if (/^FAIL\s/m.test(output)) return { passed: 0, failed: 1, total: 1 };

    return null;
}

export async function testProject({ project }) {
    const config = getProject(project);

    // Guard: project root must exist on this machine.
    // When the MCP server runs remotely, project roots on the dev's Windows
    // machine won't exist — return a clear message instead of a silent exit 1.
    if (!fs.existsSync(config.root)) {
        return {
            content: [{ type: "text", text:
                `TEST SKIPPED — project root not found on this machine: "${config.root}".\n` +
                `Run "npm test" directly in the project directory on the machine that hosts the code.`
            }],
            success: true
        };
    }

    let cmd, args;
    if (config.testCommand && config.testCommand.trim()) {
        const parts = config.testCommand.trim().split(/\s+/);
        cmd  = parts[0];
        args = parts.slice(1);
    } else {
        const entry = TEST_COMMANDS[config.type];
        if (!entry) {
            return {
                content: [{ type: "text", text:
                    `TEST SKIPPED — no test command known for project type "${config.type}".\n` +
                    `Add a "testCommand" field to projects.json to enable testing.`
                }],
                success: true
            };
        }
        [cmd, args] = entry;
    }

    log.info(`Running tests for "${project}" | cmd: ${cmd} ${args.join(" ")}`);

    // On Windows, npm/npx are .cmd scripts that require shell:true.
    // shell:true is safe here because cmd and args are static constants —
    // no user input is ever interpolated into the command string.
    const needsShell = process.platform === "win32" || cmd === "npm" || cmd === "npx";

    const result = spawnSync(cmd, args, {
        cwd:       config.root,
        encoding:  "utf-8",
        timeout:   TEST_TIMEOUT_MS,
        shell:     needsShell,
        env:       { ...process.env, CI: "true", FORCE_COLOR: "0" },
        maxBuffer: 10 * 1024 * 1024
    });

    const stdout   = (result.stdout || "").trim();
    const stderr   = (result.stderr || "").trim();
    const spawnErr = result.error ? `Spawn error: ${result.error.message}` : "";
    // Join with real newline — stored as NL constant to survive any transport encoding
    const output   = [stdout, stderr, spawnErr].filter(Boolean).join(NL);
    const exitCode = result.status ?? 1;

    if (result.error?.code === "ETIMEDOUT") {
        return {
            content: [{ type: "text", text: `TEST TIMEOUT after ${TEST_TIMEOUT_MS / 1000}s` }],
            success: false
        };
    }

    const parsed     = parseResults(output);
    const success    = exitCode === 0;
    const summary    = success ? "TEST PASSED" : `TEST FAILED (exit ${exitCode})`;
    const structured = parsed
        ? `${summary} — passed: ${parsed.passed}, failed: ${parsed.failed}, total: ${parsed.total}`
        : summary;

    log.info(`Test result for "${project}": ${structured}`);

    return {
        content: [{ type: "text", text: structured + NL + NL + output.substring(0, 6000) }],
        success,
        parsed
    };
}
