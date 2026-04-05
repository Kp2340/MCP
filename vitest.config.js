import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Run tests in Node environment (not browser)
        environment: "node",

        // Glob for test files
        include: ["tests/**/*.test.js"],

        // Show each test name in output
        reporters: ["verbose"],

        // Fail fast — stop on first test file with failures
        // bail: 1,

        // Never fail just because no test files matched the glob
        passWithNoTests: true,

        // External packages with native bindings or complex CJS interop that
        // Vite's ESM transform cannot process — leave them to Node directly.
        server: {
            deps: {
                external: [
                    /node_modules\/@xenova/,
                    /node_modules\/chromadb/,
                    /node_modules\/@google\/genai/,
                    /node_modules\/node-fetch/
                ]
            }
        },

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
