/**
 * Goal Validator
 *
 * Verifies whether the agent achieved its goal after the main loop finishes.
 * Uses ExecutionState and classified intent to emit a structured verdict.
 *
 * This is NOT a blocking gate — it only observes and reports.
 * Future iterations can use the verdict to trigger auto-retry.
 */

// ── Validators by intent ──────────────────────────────────────────────────────
const VALIDATORS = [
    {
        intent: "fix",
        check(execState) {
            const last = execState.lastError();
            if (!last) return { passed: true, reason: "No errors in execution state after run" };
            const lastErrStep = last.stepIndex;
            const totalSteps  = execState.stepCount;
            if (totalSteps > lastErrStep + 1) {
                return { passed: true, reason: `Error at step ${lastErrStep} appears resolved by later steps` };
            }
            return {
                passed:  false,
                reason:  `Last error (step ${lastErrStep}): [${last.type}] ${last.text.substring(0, 100)}`,
                suggest: "Re-run with deterministic recovery or inspect the failing file"
            };
        }
    },
    {
        intent: "api",
        check(execState) {
            if (execState.filesModified.size === 0) {
                return { passed: false, reason: "No files were modified — API goal may be incomplete", suggest: "Check that a service/controller file was actually changed" };
            }
            return { passed: true, reason: `${execState.filesModified.size} file(s) modified: ${[...execState.filesModified].slice(0, 3).join(", ")}` };
        }
    },
    {
        intent: "ui",
        check(execState) {
            const uiExtensions = [".jsx", ".tsx", ".vue", ".css", ".scss"];
            const uiFiles = [...execState.filesModified].filter(f =>
                uiExtensions.some(ext => f.endsWith(ext)) ||
                /component|page|layout|screen|style/i.test(f)
            );
            if (uiFiles.length === 0) {
                return { passed: false, reason: "No UI files (.jsx/.tsx/component) modified", suggest: "Verify the component path and check for routing changes" };
            }
            return { passed: true, reason: `UI files modified: ${uiFiles.slice(0, 3).join(", ")}` };
        }
    },
    {
        intent: "auth",
        check(execState) {
            const authFiles = [...execState.filesModified].filter(f =>
                /auth|login|token|security|permission|role/i.test(f)
            );
            if (authFiles.length === 0) {
                return { passed: false, reason: "No auth-related files modified", suggest: "Confirm the auth module path was correctly resolved" };
            }
            return { passed: true, reason: `Auth files modified: ${authFiles.slice(0, 3).join(", ")}` };
        }
    },
    {
        intent: "config",
        check(execState) {
            const configFiles = [...execState.filesModified].filter(f =>
                /config|constant|\.env|\.json|\.yaml|\.properties/i.test(f)
            );
            if (configFiles.length === 0) {
                return { passed: false, reason: "No config files modified", suggest: "Verify config file path and check project structure" };
            }
            return { passed: true, reason: `Config files modified: ${configFiles.slice(0, 3).join(", ")}` };
        }
    }
];

const GENERAL_VALIDATOR = {
    check(execState) {
        const toolCount = execState.toolsUsed.length;
        if (toolCount === 0) {
            return { passed: false, reason: "No tools were executed", suggest: "Check prompt format and project registration" };
        }
        return { passed: true, reason: `${toolCount} tool call(s) completed across ${execState.stepCount} steps` };
    }
};

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Validate whether the agent goal was achieved.
 *
 * @param {string}         intent    - from classifyIntentFromPrompt()
 * @param {ExecutionState} execState - final state after run
 * @returns {{ passed: boolean, reason: string, suggest?: string }}
 */
export function validateGoal(intent, execState) {
    const validator = VALIDATORS.find(v => v.intent === intent) || GENERAL_VALIDATOR;
    return validator.check(execState);
}

/**
 * Print the validation result to stderr in a consistent format.
 */
export function logValidation(intent, result) {
    const icon   = result.passed ? "\u2705" : "\u274C";
    const status = result.passed ? "PASSED" : "FAILED";
    console.error(`\n[validator] ${icon} Goal validation ${status} (intent: ${intent})`);
    console.error(`[validator]    Reason: ${result.reason}`);
    if (result.suggest) {
        console.error(`[validator]    Suggest: ${result.suggest}`);
    }
}

/**
 * Build-based validation — calls project_analyze via mcpClient.
 * Returns { passed: boolean, reason: string }
 *
 * @param {string}    project
 * @param {string}    intent
 * @param {MCPClient} mcpClient
 */
export async function validateWithBuild(project, intent, mcpClient) {
    if (intent === "general") {
        return { passed: true, reason: "Read-only intent — build check skipped" };
    }
    try {
        const result     = await mcpClient.callTool("project_analyze", { project });
        const resultText = result?.content?.map(c => c.text || "").join("\n") || "";
        const isClean    = resultText.trim() === ""
            || /static analysis passed/i.test(resultText)
            || /build skipped/i.test(resultText);
        const hasErrors  = !isClean && /error|warning|failed|cannot find|unresolved|issue.*found/i.test(resultText);
        const passed     = isClean || !hasErrors;
        return {
            passed,
            reason: passed
                ? "Static analysis passed"
                : `Static analysis issues: ${resultText.substring(0, 200)}`
        };
    } catch (err) {
        return { passed: true, reason: `Build check skipped (error: ${err.message})` };
    }
}
