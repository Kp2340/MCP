import express from "express";
import { AI_PROVIDER, GEMINI_API_KEY, OLLAMA_URL } from "../config/aiConfig.js";

const router = express.Router();

async function callOllama(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5-coder:7b",
      prompt,
      stream: false
    })
  });
  const data = await res.json();
  return data.response || "";
}

async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

router.post("/chat", async (req, res) => {
  const { prompt } = req.body;

  try {
    let response = "";

    if (AI_PROVIDER === "ollama") {
      response = await callOllama(prompt);
    } else if (AI_PROVIDER === "gemini") {
      response = await callGemini(prompt);
    } else {
      return res.json({ error: "No AI provider configured" });
    }

    res.json({ response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;