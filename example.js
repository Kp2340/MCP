/**
 * AI Dev MCP — Example Usage
 *
 * Run with:
 *   MCP_BASE_URL=https://your-ngrok-url.ngrok.io \
 *   MCP_API_KEY=your-api-key \
 *   node example.js
 *
 * Or set them directly below.
 */

import { MCPClient, createClientFromEnv } from "./src/client/mcpClient.js";

// ── Option A: from environment variables ──────────────────────────────────────
// const client = createClientFromEnv();

// ── Option B: explicit configuration ─────────────────────────────────────────
// ── Validate required env vars before constructing client ────────────────────
if (!process.env.MCP_BASE_URL) {
    console.error("Error: MCP_BASE_URL environment variable is required.");
    console.error("Usage: MCP_BASE_URL=https://your-server.ngrok.io MCP_API_KEY=your-key node example.js");
    process.exit(1);
}
if (!process.env.MCP_API_KEY) {
    console.error("Error: MCP_API_KEY environment variable is required.");
    console.error("Usage: MCP_BASE_URL=https://your-server.ngrok.io MCP_API_KEY=your-key node example.js");
    process.exit(1);
}

const client = new MCPClient({
    baseUrl: process.env.MCP_BASE_URL,
    apiKey:  process.env.MCP_API_KEY,
});

// ─────────────────────────────────────────────────────────────────────────────
// Example 1: Submit and stream in real-time
// ─────────────────────────────────────────────────────────────────────────────

async function exampleStream() {
    console.log("
── Example 1: Submit + stream ────────────────────────
");

    const jobId = await client.runTask({
        prompt:        "Fix the login bug — form is not validating email format",
        workspacePath: process.env.WORKSPACE_PATH || "jsv",
    });

    console.log(`Job ID: ${jobId}`);
    console.log("Streaming logs...
");

    await client.stream(jobId, (msg) => {
        const d = msg.data;
        if (msg.event === "completed") {
            console.log("
✔  DONE:", JSON.stringify(d, null, 2));
        } else if (msg.event === "failed") {
            console.error("
✘  FAILED:", JSON.stringify(d, null, 2));
        } else if (d?.log) {
            console.log(`[${d.step ?? "?"}] ${d.log}`);
        } else if (typeof d === "string") {
            console.log(d);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 2: Submit and wait (polling fallback)
// ─────────────────────────────────────────────────────────────────────────────

async function exampleWait() {
    console.log("
── Example 2: Submit + waitForCompletion ─────────────
");

    const jobId = await client.runTask({
        prompt:        "Add unit tests for the CartService class",
        workspacePath: process.env.WORKSPACE_PATH || "jsv",
    });

    console.log(`Job ID: ${jobId}
Waiting...`);

    const result = await client.waitForCompletion(jobId, (msg) => {
        if (msg.event === "poll") process.stdout.write(".");
        else if (msg.data?.log) process.stdout.write(`
  ${msg.data.log}`);
    });

    console.log("

Final result:", result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 3: Check queue and jobs
// ─────────────────────────────────────────────────────────────────────────────

async function exampleInspect() {
    console.log(`
── Example 3: Inspect queue + jobs ──────────────────
`);

    const queue = await client.getQueue();
    console.log("Queue:", queue);

    const jobs = await client.listJobs();
    console.log(`
All jobs (${jobs.length}):`);
    for (const j of jobs) {
        console.log(`  ${j.id} | ${j.status.padEnd(10)} | ${j.project ?? ""}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
    try {
        // Pick one to test:
        await exampleStream();
        // await exampleWait();
        // await exampleInspect();
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
})();
