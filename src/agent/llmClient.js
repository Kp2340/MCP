import { askLLM as askOllama, isOllamaAvailable } from "./ollamaClient.js";
import { askLLM as askGemini, isGeminiAvailable } from "./geminiClient.js";

/**
 * Ask LLM using a fallback strategy:
 * Attempts Ollama first. If Ollama is down, falls back to Gemini.
 */
export async function askLLM(model, prompt, opts = {}) {
    const ollamaStatus = await isOllamaAvailable();
    if (ollamaStatus.available) {
        try {
            return await askOllama(model, prompt, opts);
        } catch (err) {
            console.warn(`[llmClient] Ollama failed during request. Falling back to Gemini... (${err.message})`);
        }
    }
    
    // Fallback to Gemini
    return await askGemini(model, prompt, opts);
}

/**
 * Aggregate status of available LLMs.
 */
export async function isLlmAvailable() {
    const ollamaStatus = await isOllamaAvailable();
    if (ollamaStatus.available) {
        return ollamaStatus; // Return ollama status immediately if healthy
    }
    const geminiStatus = await isGeminiAvailable();
    if (geminiStatus.available) {
        return geminiStatus;
    }
    return { available: false, models: [], error: "No LLM is available (both Ollama and Gemini are down or unconfigured)." };
}
