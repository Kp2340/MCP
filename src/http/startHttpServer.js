/**
 * src/http/startHttpServer.js
 *
 * Centralised HTTP server startup extracted from index.js.
 *
 * Adds vs old inline code:
 *   - express.json({ limit: '10mb' }) — prevents OOM from oversized payloads
 *   - express.urlencoded limit (10 MB)
 *   - Global synchronous error handler — catches thrown errors in route handlers
 *   - Graceful SIGTERM / SIGINT shutdown:
 *       1. drainQueue() — mark pending jobs failed, close all SSE clients
 *       2. httpServer.close() — stop accepting new connections
 *       3. process.exit(0); force-exit after 15 s if blocked
 *
 * HOW TO WIRE IN index.js: call startHttpServer(mcpServer) after MCP server init.
 */

import http    from 'http';
import express from 'express';
import { corsMiddleware }     from './cors.js';
import { authMiddleware, ipAllowlistMiddleware, rateLimitMiddleware } from './auth.js';
import { attachMcpRoutes }    from './mcpRouter.js';
import { attachJobRoutes }    from './jobRoutes.js';
import { attachHealthRoutes } from './healthRoutes.js';
import { attachUiRoutes }       from './uiRoutes.js';
import { attachWorkspaceRoutes } from './workspaceRoutes.js';
import { runStartupChecks }   from './startupChecks.js';
import { drainQueue }         from './queue.js';
import { config }             from '../core/config.js';
import { createLogger }       from '../core/logger.js';

const log = createLogger('http');

/**
 * Create, configure, and start the Express HTTP server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} mcpServer
 * @returns {import('http').Server}
 */
export function startHttpServer(mcpServer) {
    const app = express();

    // ── Body size limit ───────────────────────────────────────────────────────
    // 10 MB cap — generous enough for large file payloads, bounded against abuse.
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // ── Cross-cutting middleware ───────────────────────────────────────────────
    app.use(corsMiddleware);
    app.use(ipAllowlistMiddleware);
    app.use(authMiddleware);

    // ── Routes ────────────────────────────────────────────────────────────────
    attachHealthRoutes(app);          // GET /health  (public, no auth)
    attachMcpRoutes(app, mcpServer);  // POST /mcp  GET /sse  POST /message

    // Rate-limit only /run — it triggers expensive agent + LLM runs
    app.use('/run', rateLimitMiddleware);

    attachJobRoutes(app);        // POST /run  GET /status /stream /diff /jobs /queue
                                 // POST /cancel/:id  POST /revert/:id
    attachWorkspaceRoutes(app);  // POST /workspace/push  GET /workspace/pull/:p  DELETE /workspace/:p
    attachUiRoutes(app);         // GET /ui

    // ── 404 fallback ─────────────────────────────────────────────────────────
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

    // ── Global synchronous error handler ─────────────────────────────────────
    // Catches errors thrown synchronously inside route handlers.
    // Async route errors must still be caught inside each route (Express 4 limit).
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        log.error('Unhandled route error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal server error' });
        }
    });

    // ── HTTP server ───────────────────────────────────────────────────────────
    const httpServer = http.createServer(app);

    httpServer.listen(config.PORT, () => {
        runStartupChecks();
        log.info(`HTTP server ready on port ${config.PORT}`);
        log.info(`  Web UI:    http://localhost:${config.PORT}/ui`);
        log.info(`  MCP HTTP:  http://localhost:${config.PORT}/mcp`);
        log.info(`  MCP SSE:   http://localhost:${config.PORT}/sse`);
        log.info(`  Health:    http://localhost:${config.PORT}/health`);
        log.info(`  Projects:  http://localhost:${config.PORT}/api/projects`);
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    // SIGTERM — Docker stop, systemd stop, process managers
    // SIGINT  — Ctrl+C in terminal
    //
    // Sequence:
    //   1. drainQueue() — mark pending jobs failed, close all SSE streams
    //   2. httpServer.close() — stop accepting connections, wait for active ones
    //   3. process.exit(0) on clean close
    //   4. Force-exit after 15 s if something is blocking
    //
    // Running jobs are NOT killed — they finish or hit JOB_TIMEOUT_MS.
    let shuttingDown = false;

    function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`${signal} received — graceful shutdown starting...`);

        drainQueue();

        httpServer.close((err) => {
            if (err) { log.error('HTTP close error:', err.message); process.exit(1); }
            log.info('Graceful shutdown complete.');
            process.exit(0);
        });

        setTimeout(() => {
            log.warn('Shutdown timed out after 15 s — forcing exit');
            process.exit(1);
        }, 15_000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    return httpServer;
}