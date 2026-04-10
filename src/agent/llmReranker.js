export async function rerankWithLLM(query, docs) {
  try {
    const prompt = `Rank the following code snippets by relevance to the query: "${query}". Return indices in best order.\n\n${docs.map((d,i)=>`[${i}] ${d}`).join("\n\n")}`;

    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5-coder:7b",
        prompt,
        stream: false
      })
    });

    const data = await res.json();
    const text = data.response || "";

    const order = text.match(/\d+/g)?.map(Number) || [];

    return order.map(i => docs[i]).filter(Boolean);
  } catch (e) {
    console.warn("[reranker] failed, fallback used");
    return docs;
  }
}