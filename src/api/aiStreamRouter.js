import express from "express";
import { AI_PROVIDER, GEMINI_API_KEY, OLLAMA_URL } from "../config/aiConfig.js";
import { retrieve } from "../agent/retriever.js";

const router = express.Router();

function buildPrompt(userPrompt, contextDocs) {
  return `You are an expert developer. Use the following project context to answer:\n\n${contextDocs.join("\n\n---\n\n")}\n\nUser request: ${userPrompt}`;
}

router.post("/stream", async (req, res) => {
  const { prompt, project } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    let docs = [];
    try {
      docs = await retrieve(project, prompt);
    } catch {
      docs = [];
    }

    const finalPrompt = buildPrompt(prompt, docs.slice(0, 5));

    let response;

    if (AI_PROVIDER === "ollama") {
      response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen2.5-coder:7b", prompt: finalPrompt, stream: true })
      });
    } else if (AI_PROVIDER === "gemini") {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }] })
      });
    } else {
      res.write(`data: No provider configured\n\n`);
      return res.end();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      res.write(`data: ${chunk}\n\n`);
    }

    res.end();
  } catch (e) {
    res.write(`data: error: ${e.message}\n\n`);
    res.end();
  }
});

export default router;