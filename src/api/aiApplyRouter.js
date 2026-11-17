import express from "express";
import { AI_PROVIDER, GEMINI_API_KEY, OLLAMA_URL } from "../config/aiConfig.js";

const router = express.Router();

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

router.post("/apply", async (req, res) => {
  const { prompt, fileContent, filePath } = req.body;

  const fullPrompt = `You are an expert developer. Modify the following file based on request. Return ONLY updated code.\n\nFile: ${filePath}\n\nCode:\n${fileContent}\n\nTask:\n${prompt}`;

  try {
    const response = await callAI(fullPrompt);

    res.json({ updatedCode: response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;