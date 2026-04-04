/**
 * src/client/mcpClient.js  —  HTTP SDK for external callers
 *
 * Used by IDE extensions, scripts, and teammate tools to talk to a
 * remote AI Dev MCP server over HTTP. Zero external dependencies.
 * Works in both Node.js and browsers.
 *
 * NOT the same as src/agent/mcpClient.js, which is the internal in-process
 * dispatcher used by the agent loop itself.
 */

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS       = 300_000; // 5 minutes

export class MCPClient {

    /**
     * @param {object} options
     * @param {string} options.baseUrl  - e.g. "https://ai.decorom.in"
     * @param {string} options.apiKey   - x-api-key header value
     * @param {number} [options.timeout]        - max wait for waitForCompletion (ms)
     * @param {number} [options.pollInterval]   - polling interval when SSE unavailable (ms)
     */
    constructor({ baseUrl, apiKey, timeout, pollInterval } = {}) {
        if (!baseUrl) throw new Error("MCPClient: baseUrl is required");
        if (!apiKey)  throw new Error("MCPClient: apiKey is required");

        this.baseUrl      = baseUrl.replace(/\/$/, "");
        this.apiKey       = apiKey;
        this.timeout      = timeout      ?? DEFAULT_TIMEOUT_MS;
        this.pollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _headers(extra = {}) {
        return {
            "Content-Type": "application/json",
            "x-api-key":    this.apiKey,
            ...extra,
        };
    }

    async _fetch(path, options = {}) {
        const url = `${this.baseUrl}${path}`;
        const res = await fetch(url, {
            ...options,
            headers: { ...this._headers(), ...(options.headers || {}) },
        });

        if (!res.ok) {
            let body = "";
            try { body = await res.text(); } catch {}
            throw new Error(`MCP ${options.method || "GET"} ${path} → ${res.status}: ${body}`);
        }

        return res;
    }

    async _json(path, options = {}) {
        const res = await this._fetch(path, options);
        return res.json();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Submit a task to the MCP server.
     *
     * Workspace-first API: pass workspacePath (absolute or relative path to the project).
     * The legacy `project` key is still accepted for backwards compatibility but deprecated.
     *
     * @param {string|object} promptOrOptions
     *   - string:  the coding instruction (legacy — also pass workspacePath as 2nd arg)
     *   - object:  { prompt, workspacePath, context? }  (recommended)
     * @param {string} [legacyWorkspacePath]  deprecated positional arg
     * @returns {Promise<string>} jobId
     */
    async runTask(promptOrOptions, legacyWorkspacePath) {
        let prompt, workspacePath, context;

        if (typeof promptOrOptions === "object" && promptOrOptions !== null) {
            // New object-form: runTask({ prompt, workspacePath, context })
            ({ prompt, workspacePath, context } = promptOrOptions);
        } else {
            // Legacy positional form: runTask(prompt, workspacePath)
            prompt        = promptOrOptions;
            workspacePath = legacyWorkspacePath;
        }

        if (!prompt)         throw new Error("runTask: prompt is required");
        if (!workspacePath)  throw new Error("runTask: workspacePath is required");

        const body = { prompt, path: workspacePath };
        if (context) body.context = context;

        const data = await this._json("/run", {
            method: "POST",
            body:   JSON.stringify(body),
        });

        return data.id;
    }

    /**
     * Fetch the current status of a job.
     *
     * @param {string} jobId
     * @returns {Promise<object>} job object: { id, status, result?, error?, logs? }
     */
    async getStatus(jobId) {
        if (!jobId) throw new Error("getStatus: jobId is required");
        return this._json(`/status/${jobId}`);
    }

    /**
     * List all jobs, optionally filtered by status.
     *
     * @param {"pending"|"running"|"completed"|"failed"|null} [statusFilter]
     * @returns {Promise<object[]>}
     */
    async listJobs(statusFilter = null) {
        const qs = statusFilter ? `?status=${statusFilter}` : "";
        return this._json(`/jobs${qs}`);
    }

    /**
     * Get queue depth and running-job info.
     *
     * @returns {Promise<object>} { pending, running }
     */
    async getQueue() {
        return this._json("/queue");
    }

    /**
     * Subscribe to live SSE updates for a job.
     * Works in both Node.js (node-fetch / undici) and modern browsers.
     *
     * @param {string}   jobId
     * @param {function} onMessage  - called with each parsed SSE event: { event, data }
     * @returns {Promise<void>}     - resolves when the stream closes
     */
    async stream(jobId, onMessage) {
        if (!jobId)     throw new Error("stream: jobId is required");
        if (!onMessage) throw new Error("stream: onMessage callback is required");

        const url = `${this.baseUrl}/stream/${jobId}`;

        // Browser path — use EventSource (no auth header support, so pass key in QS)
        if (typeof EventSource !== "undefined") {
            return this._streamBrowser(url, onMessage);
        }

        // Node.js path — use fetch with streaming body
        return this._streamNode(jobId, onMessage);
    }

    /** @private */
    _streamBrowser(url, onMessage) {
        return new Promise((resolve, reject) => {
            // Browsers can't set headers on EventSource; pass key as query param
            const src = new EventSource(`${url}?key=${encodeURIComponent(this.apiKey)}`);

            // Always close + resolve/reject — prevents dangling SSE connections
            const done = (fn, arg) => {
                try { src.close(); } catch {}
                fn(arg);
            };

            src.onmessage = (e) => {
                try { onMessage({ event: "message", data: JSON.parse(e.data) }); } catch {}
            };

            const terminal = (eventName) => {
                src.addEventListener(eventName, (e) => {
                    try { onMessage({ event: eventName, data: JSON.parse(e.data) }); } catch {}
                    done(resolve, undefined);
                });
            };

            terminal("completed");
            terminal("failed");

            src.onerror = () => {
                done(reject, new Error("SSE connection error"));
            };
        });
    }

    /** @private */
    async _streamNode(jobId, onMessage) {
        const res = await this._fetch(`/stream/${jobId}`, {
            headers: { Accept: "text/event-stream" },
        });

        const reader = res.body.getReader
            ? res.body.getReader()           // WHATWG Streams (undici)
            : res.body;                      // Node.js Readable fallback

        if (reader.read) {
            // WHATWG Streams
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                buffer  = this._parseSSEBuffer(buffer, onMessage);
            }
        } else {
            // Older Node.js readable stream
            await new Promise((resolve, reject) => {
                let buffer = "";
                reader.setEncoding("utf8");
                reader.on("data", (chunk) => {
                    buffer += chunk;
                    buffer = this._parseSSEBuffer(buffer, onMessage);
                });
                reader.on("end",   resolve);
                reader.on("error", reject);
            });
        }
    }

    /** @private */
    _parseSSEBuffer(buffer, onMessage) {
        const parts = buffer.split("

");
        // Last part may be incomplete — keep it
        const incomplete = parts.pop();

        for (const block of parts) {
            const lines = block.split("
");
            let event = "message";
            let data  = null;

            for (const line of lines) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                if (line.startsWith("data:"))  data  = line.slice(5).trim();
            }

            if (data !== null && data !== "" && !data.startsWith(":")) {
                try { onMessage({ event, data: JSON.parse(data) }); } catch {
                    onMessage({ event, data });
                }
            }
        }

        return incomplete;
    }

    /**
     * Wait until a job reaches a terminal state (completed / failed).
     * Uses SSE when available, falls back to polling.
     *
     * @param {string}   jobId
     * @param {function} [onProgress] - optional callback for intermediate updates
     * @returns {Promise<object>} final job object
     */
    async waitForCompletion(jobId, onProgress) {
        const deadline = Date.now() + this.timeout;

        return new Promise(async (resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`waitForCompletion: timed out after ${this.timeout}ms`));
            }, this.timeout);

            const cleanup = () => clearTimeout(timeoutId);

            try {
                // Try SSE first
                await this.stream(jobId, (msg) => {
                    if (onProgress) onProgress(msg);

                    if (msg.event === "completed" || msg.event === "failed") {
                        cleanup();
                        if (msg.event === "failed") {
                            reject(new Error(`Job ${jobId} failed: ${JSON.stringify(msg.data)}`));
                        } else {
                            resolve(msg.data);
                        }
                    }
                });
                cleanup();
            } catch {
                // SSE failed — fall back to polling
                cleanup();
                this._pollUntilDone(jobId, onProgress, deadline)
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    /** @private */
    async _pollUntilDone(jobId, onProgress, deadline) {
        while (Date.now() < deadline) {
            const job = await this.getStatus(jobId);
            if (onProgress) onProgress({ event: "poll", data: job });

            if (job.status === "completed") return job;
            if (job.status === "failed")    throw new Error(`Job ${jobId} failed: ${job.error}`);

            await new Promise(r => setTimeout(r, this.pollInterval));
        }
        throw new Error(`Polling timed out for job ${jobId}`);
    }
}

// ── Environment-aware factory ─────────────────────────────────────────────────

/**
 * Create a client from environment variables.
 * Works in Node.js; in browsers set window.MCP_BASE_URL / window.MCP_API_KEY.
 *
 * @returns {MCPClient}
 */
export function createClientFromEnv() {
    const baseUrl = (typeof process !== "undefined" && process.env?.MCP_BASE_URL)
        || (typeof window !== "undefined" && window.MCP_BASE_URL)
        || "";

    const apiKey = (typeof process !== "undefined" && process.env?.MCP_API_KEY)
        || (typeof window !== "undefined" && window.MCP_API_KEY)
        || "";

    return new MCPClient({ baseUrl, apiKey });
}
