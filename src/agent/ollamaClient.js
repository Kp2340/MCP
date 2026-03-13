import fetch from "node-fetch";

const OLLAMA_URL = "http://localhost:11434/api/generate";

export async function askLLM(model, prompt) {

    const response = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: {
                temperature: 0.1,
                num_predict: 400,
                top_p: 0.9
            }
        })
    });

    if (!response.ok) {
        throw new Error("Ollama request failed");
    }

    const data = await response.json();

    return data.response.trim();
}