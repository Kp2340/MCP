import fetch from "node-fetch";
import { OLLAMA_HOST, LLM_TEMPERATURE } from "../core/constants.js";

const OLLAMA_URL  = `${OLLAMA_HOST}/api/generate`;
const OLLAMA_TAGS = `${OLLAMA_HOST}/api/tags`;

// ── Availability cache ────────────────────────────────────────────────────────
// Checked once at startup and after failures; avoids hammering Ollama when down.
let _ollamaAvailable = null;   // null = unknown, true/false = cached result
let _lastCheck       = 0;
const CHECK_TTL      = 30_000; // re-check every 30 s

/**
 * Check whether Ollama is reachable and has at least one model loaded.
 * Result is cached for CHECK_TTL ms.
 *
 * @returns {Promise<{ available: boolean, models: string[], error?: string }>}
 */
export async function isOllamaAvailable() {
    const now = Date.now();
    if (_ollamaAvailable !== null && now - _lastCheck < CHECK_TTL) {
        return { available: _ollamaAvailable, models: [] };
    }

    try {
        const res = await fetch(OLLAMA_TAGS, {
            signal: AbortSignal.timeout(5_000)
        });
        if (!res.ok) {
            _ollamaAvailable = false;
            _lastCheck = now;
            return { available: false, models: [], error: `HTTP ${res.status}` };
        }
        const data   = await res.json();
        const models = (data.models || []).map(m => m.name);
        _ollamaAvailable = true;
        _lastCheck = now;
        return { available: true, models };
    } catch (err) {
        _ollamaAvailable = false;
        _lastCheck = now;
        return { available: false, models: [], error: err.message };
    }
}

/**
 * Call the local Ollama LLM with exponential backoff retry.
 *
 * Retry schedule: 1st retry after 2 s, 2nd after 4 s.
 * On AbortError (timeout) the backoff doubles each attempt.
 *
 * @param {string} model       - model name, e.g. "qwen2.5-coder:7b"
 * @param {string} prompt      - full prompt string
 * @param {object} [opts]      - optional overrides
 * @param {number} [opts.temperature=0.1]
 * @param {number} [opts.num_predict=2048]
 * @param {number} [opts.timeout=180000]   - per-attempt timeout in ms
 */
export async function askLLM(model, prompt, opts = {}) {
    const body = {
        model,
        prompt,
        stream: false,
        options: {
            temperature: opts.temperature ?? LLM_TEMPERATURE,
            num_predict: opts.num_predict ?? 2048,
            top_p: 0.9
        }
    };

    const baseTimeoutMs = opts.timeout ?? 180_000;  // 3 min default
    const MAX_ATTEMPTS  = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Exponential backoff: 2s, 4s (only on retries)
        if (attempt > 0) {
            const waitMs = 2_000 * Math.pow(2, attempt - 1);
            console.warn(`[ollama] Retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        // Slightly increase timeout on retries to tolerate slow cold-starts
        const timeoutMs   = baseTimeoutMs * (1 + attempt * 0.5);
        const controller  = new AbortController();
        const timer       = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(OLLAMA_URL, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify(body),
                signal:  controller.signal
            });
            clearTimeout(timer);

            if (!res.ok) {
                // Surface the Ollama error body for better diagnostics
                let errDetail = `HTTP ${res.status}`;
                try {
                    const errBody = await res.text();
                    if (errBody) errDetail += ` — ${errBody.substring(0, 200)}`;
                } catch { /* ignore */ }

                // 404 usually means the model isn't pulled yet
                if (res.status === 404) {
                    throw new Error(
                        `Ollama model "${model}" not found. ` +
                        `Run: ollama pull ${model}`
                    );
                }
                throw new Error(`Ollama ${errDetail}`);
            }

            const data     = await res.json();
            const response = data.response?.trim() ?? "";

            // Invalidate availability cache on successful call
            _ollamaAvailable = true;
            _lastCheck = Date.now();

            // Warn if model returned empty response (common with wrong prompts)
            if (!response && attempt === MAX_ATTEMPTS - 1) {
                console.warn(`[ollama] Empty response from model "${model}" (prompt length: ${prompt.length})`);
            }

            return response;

        } catch (err) {
            clearTimeout(timer);
            const isAbort    = err.name === "AbortError";
            const isLastTry  = attempt === MAX_ATTEMPTS - 1;

            // Mark Ollama unavailable on connection errors (not on timeouts)
            if (!isAbort && err.code && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(err.code)) {
                _ollamaAvailable = false;
                _lastCheck = Date.now();
            }

            if (isLastTry) {
                const reason = isAbort
                    ? `timeout after ${Math.round(timeoutMs / 1000)}s`
                    : err.message;
                throw new Error(`LLM failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
            }
        }
    }
}
