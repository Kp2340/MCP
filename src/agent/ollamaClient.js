import fetch from "node-fetch";
import { OLLAMA_HOST, LLM_TEMPERATURE } from "../core/constants.js";

const OLLAMA_URL = `${OLLAMA_HOST}/api/generate`;

/**
 * Call the local Ollama LLM.
 *
 * @param {string} model   - model name, e.g. "qwen2.5-coder:7b"
 * @param {string} prompt  - full prompt string
 * @param {object} opts    - optional overrides: temperature, num_predict
 */
export async function askLLM(model, prompt, opts = {}) {
    const body = {
        model,
        prompt,
        stream: false,
        options: {
            temperature: opts.temperature ?? 0.1,   // Low temp = more deterministic JSON
            num_predict: opts.num_predict ?? 2048,
            top_p: 0.9
        }
    };

    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeoutMs  = opts.timeout ?? 180_000;  // 3 min default; caller can override
        const timer      = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(OLLAMA_URL, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify(body),
                signal:  controller.signal
            });
            clearTimeout(timer);

            if (!res.ok) {
                throw new Error(`Ollama HTTP ${res.status}`);
            }

            const data = await res.json();
            return data.response?.trim() ?? "";

        } catch (err) {
            clearTimeout(timer);
            const isAbort = err.name === "AbortError";
            if (attempt === 2) throw new Error(`LLM failed after 3 attempts: ${isAbort ? `timeout after ${timeoutMs}ms` : err.message}`);
            console.warn(`LLM retry ${attempt + 1}/3... (${isAbort ? "timeout" : err.message})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}