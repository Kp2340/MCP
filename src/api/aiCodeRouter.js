import express from "express";
import { AI_PROVIDER, GEMINI_API_KEY, OLLAMA_URL } from "../config/aiConfig.js";
import { retrieve } from "../agent/retriever.js";

const router = express.Router();

function buildPrompt(userPrompt, contextDocs, fileContext) {
  return `You are an expert developer.\n\nProject Context:\n${contextDocs.join("\n\n---\n\n")}\n\nCurrent File:\n${fileContext || "N/A"}\n\nTask:\n${userPrompt}`;
}

async function callAI(prompt) {
  if (AI_PROVIDER === "ollama") {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen2.5-coder:7b", prompt, stream: false })
    });
    const data = await res.json();
    return data.response || "";
  }

  if (AI_PROVIDER === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  return "";
}

router.post("/code", async (req, res) => {
  const { prompt, project, fileContent } = req.body;

  try {
    let docs = [];
    try {
      docs = await retrieve(project, prompt);
    } catch {
      docs = [];
    }

    const finalPrompt = buildPrompt(prompt, docs.slice(0, 5), fileContent);

    const response = await callAI(finalPrompt);

    res.json({ response, contextUsed: docs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;