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
const client = new MCPClient({
    baseUrl: process.env.MCP_BASE_URL || "https://markus-idiorrhythmic-osseously.ngrok-free.dev",
    apiKey:  process.env.MCP_API_KEY  || "kush-full-stack-developer-java-with-react",
});

// ─────────────────────────────────────────────────────────────────────────────
// Example 1: Submit and stream in real-time
// ─────────────────────────────────────────────────────────────────────────────

async function exampleStream() {
    console.log("\n── Example 1: Submit + stream ────────────────────────\n");

    const jobId = await client.runTask(
        "Fix the login bug — form is not validating email format",
        "jsv"
    );

    console.log(`Job ID: ${jobId}`);
    console.log("Streaming logs...\n");

    await client.stream(jobId, (msg) => {
        const d = msg.data;
        if (msg.event === "completed") {
            console.log("\n✔  DONE:", JSON.stringify(d, null, 2));
        } else if (msg.event === "failed") {
            console.error("\n✘  FAILED:", JSON.stringify(d, null, 2));
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
    console.log("\n── Example 2: Submit + waitForCompletion ─────────────\n");

    const jobId = await client.runTask(
        "Add unit tests for the CartService class",
        "jsv"
    );

    console.log(`Job ID: ${jobId}\nWaiting...`);

    const result = await client.waitForCompletion(jobId, (msg) => {
        if (msg.event === "poll") process.stdout.write(".");
        else if (msg.data?.log) process.stdout.write(`\n  ${msg.data.log}`);
    });

    console.log("\n\nFinal result:", result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 3: Check queue and jobs
// ─────────────────────────────────────────────────────────────────────────────

async function exampleInspect() {
    console.log("\n── Example 3: Inspect queue + jobs ──────────────────\n");

    const queue = await client.getQueue();
    console.log("Queue:", queue);

    const jobs = await client.listJobs();
    console.log(`\nAll jobs (${jobs.length}):`);
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
