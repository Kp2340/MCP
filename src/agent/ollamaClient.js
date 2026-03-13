import fetch from "node-fetch";

const OLLAMA_URL = "http://localhost:11434/api/generate";

export async function askLLM(model, prompt, opts = {}) {

    const body = {
        model,
        prompt,
        stream: false,
        options: {
            temperature: opts.temperature ?? 0.1,
            num_predict: opts.num_predict ?? 800,
            top_p: 0.9
        }
    };

    for (let attempt = 0; attempt < 3; attempt++) {

        try {

            const res = await fetch(OLLAMA_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                throw new Error(`Ollama HTTP ${res.status}`);
            }

            const data = await res.json();

            return data.response?.trim() ?? "";

        } catch (err) {

            if (attempt === 2) {
                throw new Error(`LLM failed: ${err.message}`);
            }

            console.warn(`LLM retry ${attempt + 1}/3`);

            await new Promise(r => setTimeout(r, 2000));
        }
    }
}