/**
 * src/http/mcpRouter.js
 *
 * MCP JSON-RPC router for HTTP transport.
 *
 * The MCP SDK's SSEServerTransport handles the protocol framing.
 * This module wires it to Express routes:
 *
 *   GET  /sse      → opens SSE stream, one per client
 *   POST /message  → receives client JSON-RPC messages, routes to MCP server
 *
 * Multiple clients can connect simultaneously. Each gets their own
 * SSEServerTransport instance. Tool calls execute serially per client
 * (the queue in queue.js handles global single-concurrency).
 */

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createLogger }       from "../core/logger.js";

const log = createLogger("mcp-router");

// Map of sessionId → SSEServerTransport
// Needed so POST /message can route to the right transport
const transports = new Map();

/**
 * Attach MCP SSE routes to an Express app.
 *
 * @param {import("express").Application} app
 * @param {import("@modelcontextprotocol/sdk/server/index.js").Server} mcpServer
 */
export function attachMcpRoutes(app, mcpServer) {

    // ── GET /sse ──────────────────────────────────────────────────────────────
    // IDE / plugin connects here. One long-lived SSE stream per client.
    app.get("/sse", async (req, res) => {
        const sessionId = req.headers["x-session-id"] || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const clientIp  = req.headers["x-forwarded-for"] || req.ip;

        log.info(`SSE client connected: sessionId=${sessionId} ip=${clientIp}`);

        // SSE headers
        res.setHeader("Content-Type",  "text/event-stream");
        res.setHeader("Connection",     "keep-alive");
        res.setHeader("x-session-id",   sessionId);
        res.flushHeaders();

        const transport = new SSEServerTransport("/message", res);
        transports.set(sessionId, transport);

        // Clean up on disconnect
        req.on("close", () => {
            transports.delete(sessionId);
            log.info(`SSE client disconnected: sessionId=${sessionId}`);
        });

        try {
            await mcpServer.connect(transport);
        } catch (err) {
            log.error(`SSE connect error for ${sessionId}:`, err.message);
            transports.delete(sessionId);
        }
    });

    // ── POST /message ─────────────────────────────────────────────────────────
    // IDE / plugin sends JSON-RPC tool calls here.
    // x-session-id header links the POST back to the right SSE stream.
    app.post("/message", async (req, res) => {
        const sessionId = req.headers["x-session-id"];

        if (!sessionId) {
            log.warn("POST /message missing x-session-id header");
            return res.status(400).json({ error: "Missing x-session-id header" });
        }

        const transport = transports.get(sessionId);
        if (!transport) {
            log.warn(`POST /message unknown session: ${sessionId}`);
            return res.status(404).json({ error: `Session ${sessionId} not found. Connect to /sse first.` });
        }

        log.debug(`POST /message | session=${sessionId} | method=${req.body?.method}`);

        try {
            await transport.handlePostMessage(req, res);
        } catch (err) {
            log.error(`POST /message error for ${sessionId}:`, err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
    });

    log.info("MCP SSE routes attached: GET /sse  POST /message");
}
