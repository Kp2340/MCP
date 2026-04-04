// patch-agent.js has been deleted.
// stepCapGuard() is now permanently embedded in src/agent/agent.js source.
// See: while (remainingSteps.length > 0) { if (stepCapGuard()) break; ... }
// This file is intentionally left as a tombstone to prevent accidental re-creation.
// Safe to delete this file entirely.

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
    "while (remainingSteps.length > 0) {
" +
    "        // ── HARD STEP CAP ── Must be first check — no bypass, no exception
" +
    "        if (stepCapGuard()) break;
";

if (!src.includes(WHILE_OPEN)) {
    console.error("[patch-agent] ERROR: Could not find while loop anchor. Pattern not found:");
    console.error(`  '${WHILE_OPEN}'`);
    process.exit(1);
}

src = src.replace(WHILE_OPEN, GUARD_BLOCK);
fs.writeFileSync(agentPath, src, "utf8");
console.log("[patch-agent] ✅ stepCapGuard() injected into while loop in src/agent/agent.js");
console.log("[patch-agent] You can now delete this script: del patch-agent.js");
