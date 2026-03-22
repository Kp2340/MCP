import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Run tests in Node environment (not browser)
        environment: "node",

        // Glob for test files
        include: ["tests/**/*.test.js"],

        // Show each test name in output
        reporter: "verbose",

        // Fail fast — stop on first test file with failures
        // bail: 1,

        // Coverage (used by npm run test:coverage)
        coverage: {
            provider:   "v8",
            reporter:   ["text", "lcov"],
            include:    ["src/**/*.js"],
            exclude:    [
                "src/index.js",          // entry point, hard to unit-test
                "src/vector/runIndex.js", // CLI scripts
                "src/vector/runIndexCore.js",
                "src/training/finetune.py"
            ]
        }
    }
});
