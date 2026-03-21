import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("mcp-router");
const transports = new Map();

export function attachMcpRoutes(app, mcpServer) {

    app.get("/sse", async (req, res) => {
        const sessionId = req.headers["x-session-id"] ||
            `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        log.info(`SSE client connected: sessionId=${sessionId} ip=${req.headers["x-forwarded-for"] || req.ip}`);

        const transport = new SSEServerTransport("/message", res);
        transports.set(sessionId, transport);

        res.setHeader("x-session-id", sessionId);

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

    app.post("/message", async (req, res) => {
        const sessionId = req.headers["x-session-id"];

        if (!sessionId) {
            return res.status(400).json({ error: "Missing x-session-id header" });
        }

        const transport = transports.get(sessionId);
        if (!transport) {
            return res.status(404).json({ error: `Session ${sessionId} not found. Connect to /sse first.` });
        }

        try {
            await transport.handlePostMessage(req, res);
        } catch (err) {
            log.error(`POST /message error:`, err.message);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    log.info("MCP SSE routes attached: GET /sse  POST /message");
}