import { GoogleGenAI } from "@google/genai";
import { config } from "../core/config.js";

// Cache for Gemini API client
let _geminiClient = null;

function getClient() {
    if (!_geminiClient) {
        if (!config.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY is not configured in .env or system environment.");
        }
        _geminiClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    }
    return _geminiClient;
}

/**
 * Check whether Gemini API is available (by verifying the API key is present).
 *
 * @returns {Promise<{ available: boolean, models: string[], error?: string }>}
 */
export async function isGeminiAvailable() {
    try {
        if (!config.GEMINI_API_KEY) {
            return { available: false, models: [], error: "GEMINI_API_KEY not set" };
        }
        // As long as the key is present, we assume availability.
        return { available: true, models: [config.LLM_MODEL || "gemini-1.5-flash"] };
    } catch (err) {
        return { available: false, models: [], error: err.message };
    }
}

/**
 * Call the Google Gemini API.
 *
 * @param {string} model       - model name, e.g. "gemini-2.5-flash"
 * @param {string} prompt      - full prompt string
 * @param {object} [opts]      - optional overrides
 * @param {number} [opts.temperature=0.1]
 * @param {number} [opts.num_predict=2048]
 * @param {number} [opts.timeout=180000]   - ignored, let the SDK handle timeouts.
 */
export async function askLLM(modelName, prompt, opts = {}) {
    const ai = getClient();
    
    // Map non-Gemini models (like qwen) to a compatible fallback
    let modelToUse = modelName || config.LLM_MODEL || "gemini-1.5-flash";
    if (modelToUse.includes("qwen") || !modelToUse.includes("gemini")) {
        modelToUse = "gemini-1.5-flash";
    }

    const maxTokens = opts.num_predict ?? 2048;
    const temperature = opts.temperature ?? 0.1;
    
    try {
        // Use the getGenerativeModel + generateContent pattern for the Google SDK
        const model = ai.getGenerativeModel({ model: modelToUse });
        
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: temperature,
                maxOutputTokens: maxTokens,
            }
        });

        const response = await result.response;
        const text = response.text()?.trim() ?? "";
        
        if (!text) {
             console.warn(`[gemini] Empty response from model "${modelToUse}"`);
        }
        return text;
    } catch (err) {
        throw new Error(`Gemini LLM failed: ${err.message}`);
    }
}
