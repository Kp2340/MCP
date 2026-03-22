import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createLogger } from "../core/logger.js";
import { config } from "../core/config.js";

const log = createLogger("mcp-router");
const transports = new Map();

/**
 * Resolve the public base URL for this server.
 * When running behind a reverse proxy (Cloudflare tunnel, ngrok, Tailscale),
 * the SDK sends an "endpoint" SSE event to the client telling it where to POST
 * messages. That URL must be the public-facing URL, not localhost.
 *
 * Priority:
 *   1. X-Forwarded-Host + X-Forwarded-Proto from the proxy
 *   2. Host header + protocol from the request
 *   3. BASE_URL from .env (fallback)
 */
function resolvePublicBase(req) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const forwardedHost  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-for"];
    if (forwardedProto && forwardedHost) {
        const proto = forwardedProto.split(",")[0].trim();
        const host  = forwardedHost.split(",")[0].trim();
        return `${proto}://${host}`;
    }
    // Fall back to Host header
    const host = req.headers["host"];
    if (host) {
        const proto = req.secure ? "https" : "http";
        return `${proto}://${host}`;
    }
    // Last resort: configured BASE_URL
    return config.BASE_URL;
}

export function attachMcpRoutes(app, mcpServer) {

    app.get("/sse", async (req, res) => {
        const sessionId = req.headers["x-session-id"] ||
            `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // Build the full public message URL so clients behind a proxy
        // (Cloudflare tunnel, ngrok, Tailscale) can POST back correctly.
        const publicBase  = resolvePublicBase(req);
        const messageUrl  = `${publicBase}/message`;

        log.info(`SSE client connected: sessionId=${sessionId} ip=${req.headers["x-forwarded-for"] || req.ip} messageUrl=${messageUrl}`);

        const transport = new SSEServerTransport(messageUrl, res);
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
        // Accept session ID from header OR query string.
        // The MCP SDK appends ?sessionId=<id> to the message URL it sends to clients,
        // so most well-behaved clients will use the query string automatically.
        // The x-session-id header is kept for backward compatibility.
        const sessionId = req.query.sessionId || req.headers["x-session-id"];

        if (!sessionId) {
            return res.status(400).json({ error: "Missing sessionId (query param or x-session-id header)" });
        }

        const transport = transports.get(sessionId);
        if (!transport) {
            log.warn(`Session not found: ${sessionId} — known sessions: ${[...transports.keys()].join(", ") || "none"}`);
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