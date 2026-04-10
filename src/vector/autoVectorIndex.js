import { spawn } from "child_process";

let debounceTimer = null;

export function runVectorIndex(project) {
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    try {
      spawn("node", ["src/vector/runIndex.js", project], {
        stdio: "ignore",
        detached: true
      }).unref();

      console.log("[vector] batch indexing triggered");
    } catch (e) {
      console.warn("[vector] auto index failed:", e.message);
    }
  }, 1000);
}
