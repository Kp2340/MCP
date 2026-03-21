/**
 * src/agent/agentRunner.js
 *
 * Thin wrapper that exports runAgent for use by the HTTP job queue.
 * Keeps agent.js unchanged (it has its own readline CLI loop).
 *
 * The queue calls runAgent(prompt) where prompt already includes
 * "project: <name>" as required by the agent's project matcher.
 */

export { runAgent } from "./agent.js";
