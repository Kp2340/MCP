/**
 * patch-agent.js
 *
 * One-shot script: injects the stepCapGuard() call into the
 * `while (remainingSteps.length > 0)` loop in src/agent/agent.js.
 *
 * Run ONCE from the project root:
 *   node patch-agent.js
 *
 * Safe to re-run — skips if guard is already present.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(__dirname, "src", "agent", "agent.js");

let src = fs.readFileSync(agentPath, "utf8");

// Already patched?
if (src.includes("stepCapGuard()") && src.includes("HARD STEP CAP")) {
    // Check the guard is actually *inside* the while loop (not just defined)
    const whileIdx = src.indexOf("while (remainingSteps.length > 0)");
    const guardIdx = src.indexOf("if (stepCapGuard()) break;");
    if (whileIdx !== -1 && guardIdx !== -1 && guardIdx > whileIdx && guardIdx < whileIdx + 200) {
        console.log("[patch-agent] Already patched — no changes needed.");
        process.exit(0);
    }
}

// Target: the opening of the while loop — inject guard as FIRST statement
const WHILE_OPEN = "while (remainingSteps.length > 0) {";
const GUARD_BLOCK =
    "while (remainingSteps.length > 0) {\n" +
    "        // ── HARD STEP CAP ── Must be first check — no bypass, no exception\n" +
    "        if (stepCapGuard()) break;\n";

if (!src.includes(WHILE_OPEN)) {
    console.error("[patch-agent] ERROR: Could not find while loop anchor. Pattern not found:");
    console.error(`  '${WHILE_OPEN}'`);
    process.exit(1);
}

src = src.replace(WHILE_OPEN, GUARD_BLOCK);
fs.writeFileSync(agentPath, src, "utf8");
console.log("[patch-agent] ✅ stepCapGuard() injected into while loop in src/agent/agent.js");
console.log("[patch-agent] You can now delete this script: del patch-agent.js");
