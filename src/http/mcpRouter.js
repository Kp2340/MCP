/**
 * src/http/mcpRouter.js
 *
 * Dual-transport MCP router:
 *
 *   POST /mcp  — Streamable HTTP, stateless + JSON response mode
 *               Used by: Gemini CLI, Claude Code, Cursor, Windsurf
 *               Each POST gets an immediate JSON response (no streaming).
 *               Notifications return 202 immediately — no timeout.
 *               Works cleanly through Cloudflare tunnels and any proxy.
 *
 *   GET  /sse       — Legacy SSE (2024-11-05 spec, kept for compatibility)
 *   POST /message   — Legacy SSE message endpoint
 *               Used by: Claude Desktop older versions, older IDE plugins
 */

import { SSEServerTransport }            from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger }                  from "../core/logger.js";
import { config }                        from "../core/config.js";

const log = createLogger("mcp-router");

// Legacy SSE sessions only
const sseSessions = new Map();

function resolvePublicBase(req) {
    const proto = req.headers["x-forwarded-proto"]?.split(",")[0].trim();
    const host  = req.headers["x-forwarded-host"]?.split(",")[0].trim()
               || req.headers["host"];
    if (proto && host) return `${proto}://${host}`;
    if (host)          return `${req.secure ? "https" : "http"}://${host}`;
    return config.BASE_URL;
}

export function attachMcpRoutes(app, mcpServer) {

    // ── Streamable HTTP — stateless, JSON response mode ────────────────────────────────
    // One shared mcpServer, new transport per request.
    // enableJsonResponse:true makes every response immediate JSON — no open connections.
    // sessionIdGenerator:undefined = stateless, no Mcp-Session-Id tracking.
    app.post("/mcp", async (req, res) => {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse:  true,
        });
        res.on("close", () => transport.close());
        try {
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            log.error("/mcp error:", err.message);
            if (!res.headersSent) res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: err.message },
                id: null
            });
        }
    });

    app.delete("/mcp", (_req, res) => res.status(200).end());

    // ── Legacy SSE transport ────────────────────────────────────────────────────────────
    app.get("/sse", async (req, res) => {
        const publicBase = resolvePublicBase(req);
        const messageUrl = `${publicBase}/message`;
        log.info(`Legacy SSE connect from ${req.headers["x-forwarded-for"] || req.ip} — endpoint=${messageUrl}`);

        const transport = new SSEServerTransport(messageUrl, res);
        sseSessions.set(transport.sessionId, transport);
        res.setHeader("x-session-id", transport.sessionId);

        req.on("close", () => {
            sseSessions.delete(transport.sessionId);
            log.info(`Legacy SSE closed: ${transport.sessionId}`);
        });

        try {
            await mcpServer.connect(transport);
        } catch (err) {
            log.error("Legacy SSE connect error:", err.message);
            sseSessions.delete(transport.sessionId);
        }
    });

    app.post("/message", async (req, res) => {
        const sessionId = req.query.sessionId || req.headers["x-session-id"];
        if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
        const transport = sseSessions.get(sessionId);
        if (!transport) {
            log.warn(`Legacy SSE session not found: ${sessionId}`);
            return res.status(404).json({ error: `Session ${sessionId} not found. Reconnect to /sse.` });
        }
        try {
            await transport.handlePostMessage(req, res);
        } catch (err) {
            log.error("/message error:", err.message);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    log.info("MCP routes: POST /mcp (Streamable HTTP stateless)  GET /sse  POST /message (Legacy SSE)");
}
