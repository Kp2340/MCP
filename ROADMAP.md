# AI Dev MCP — Roadmap & Custom Model Strategy

## Phase 1 — Current (v9.0.0) ✅

All critical bugs fixed and code optimised. System is stable for 1-2 concurrent users
on a single hosted laptop.

**What was fixed in this version:**
- `extractJSON()` centralised in `utils/jsonUtils.js` — used by executor AND autoFixLoop
- `semanticIndexer.js` — correct AST node extraction (`childForFieldName('name')`)
- `dependencyGraph.js` + `semanticIndexer.js` — both now skip `node_modules` and ignored folders
- Shell injection in `applyChanges.js` — switched to `spawnSync` with args array
- `autoFixLoop.js` — now sends file context alongside errors to the LLM
- `projectBuild.js` — 120s timeout added, no more infinite hangs
- `ollamaClient.js` — shared by all callers, `temperature: 0.1` enforced everywhere
- `projectFindSymbol.js` — auto-builds index if missing
- `mcpClient.js` — 60s timeout (was 20s), rejects pending calls on server exit
- `projectRegistry.js` — hot reload, no restart needed to add a project
- New tool: `project_list` — agents can discover available projects

---

## Phase 2 — Team Usability (2–4 weeks)

### 2a. HTTP/SSE transport (priority)
Add an HTTP server alongside stdio so teammates can connect from their own machines.

```js
// In src/index.js — add alongside StdioServerTransport:
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
app.get("/sse", (req, res) => {
    const transport = new SSEServerTransport("/message", res);
    server.connect(transport);
});
app.post("/message", express.json(), handler);
app.listen(3001);
```

Team members point their MCP client at `http://your-laptop-ip:3001/sse`.
Use **Tailscale** for secure access outside the office — no firewall config needed.

### 2b. Search/replace edits (biggest quality gap vs Cursor)
Add a `project_apply_search_replace` tool that takes targeted diffs instead of
full file rewrites. Massively reduces tokens and prevents accidental deletion of
code outside the target area.

```js
// Tool args:
{
  "project": "string",
  "edits": [
    {
      "path": "src/components/Login.jsx",
      "search": "exact string to find",
      "replace": "replacement string"
    }
  ],
  "commitMessage": "message"
}
```

### 2c. IntelliJ plugin
See `INTELLIJ_PLUGIN.md` for the full plan. Short version:
- Check if JetBrains AI Assistant (2024.2+) supports custom MCP servers in Settings first
- If not: build a Kotlin tool window plugin that POSTs to your HTTP endpoint
- Plugin auto-injects current file path + selected text into every prompt

---

## Phase 3 — Custom Model for Company Privacy (1–3 months)

This is the most important long-term step. Running a fine-tuned private model means:
- Your codebase, architecture decisions, and internal APIs never leave your network
- The model learns your team's coding conventions and project structure
- Token efficiency improves because the model already "knows" your domain

### Step 1 — Collect training data from your own projects
Export conversations where the agent successfully completed tasks. Each
successful run produces a (prompt → tool calls → result) trajectory that can
be used as a training example.

```
src/training/
├── collector.js      ← logs successful agent runs to JSONL
├── formatter.js      ← converts logs to fine-tune format
└── dataset/
    └── runs.jsonl    ← accumulated training examples
```

Format each example as a chat turn:
```jsonl
{"messages": [
  {"role": "system", "content": "You are an AI coding agent..."},
  {"role": "user",   "content": "Step: Read the Login component"},
  {"role": "assistant", "content": "{\"tool\":\"project_read_files\",\"args\":{...}}"}
]}
```

### Step 2 — Fine-tune qwen2.5-coder:7b on your data

Use **Unsloth** (fastest fine-tuning on consumer GPUs — your RTX 3050 Ti can do it):

```bash
pip install unsloth
```

```python
# finetune.py
from unsloth import FastLanguageModel
from trl import SFTTrainer
from datasets import load_dataset

model, tokenizer = FastLanguageModel.from_pretrained(
    "unsloth/Qwen2.5-Coder-7B-Instruct",
    max_seq_length=4096,
    load_in_4bit=True       # Fits in 4GB VRAM with QLoRA
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,                   # LoRA rank — higher = more capacity, more VRAM
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing=True
)

dataset = load_dataset("json", data_files="src/training/dataset/runs.jsonl")

trainer = SFTTrainer(
    model=model,
    train_dataset=dataset["train"],
    dataset_text_field="messages",
    max_seq_length=4096,
    num_train_epochs=3,
)
trainer.train()

# Export to Ollama-compatible GGUF format
model.save_pretrained_gguf("my-coder-model", tokenizer, quantization_method="q4_k_m")
```

### Step 3 — Register with Ollama and swap in

```bash
# Create Modelfile
echo 'FROM ./my-coder-model-Q4_K_M.gguf' > Modelfile
echo 'SYSTEM "You are an expert coding agent..."' >> Modelfile

ollama create company-coder -f Modelfile
```

Then in `src/agent/ollamaClient.js` and `planner.js`:
```js
const MODEL = "company-coder";   // was "qwen2.5-coder:7b"
```

### Step 4 — What to store in the model vs ChromaDB

| Data type | Where to store | Reason |
|---|---|---|
| Coding style / conventions | Fine-tune (baked into weights) | Static, changes rarely |
| Internal API patterns | Fine-tune | Core domain knowledge |
| Current file contents | ChromaDB (RAG) | Changes frequently |
| Recent code history | ChromaDB | Dynamic |
| Architecture decisions | Both | Fine-tune for patterns, RAG for specifics |
| Secrets / credentials | Neither — use env vars | Security |

### Hardware note for fine-tuning on your RTX 3050 Ti
- QLoRA (4-bit) makes fine-tuning a 7B model possible on 4GB VRAM
- Expect ~2–4 hours per training run on your hardware
- You need ~50–200 successful agent run examples to see meaningful improvement
- Run fine-tuning overnight — the laptop stays on anyway

---

## Phase 4 — Multi-user & Scale (3+ months)

Once the custom model is working:

- **Request queue**: Add a simple queue so 2+ team members can submit tasks
  without racing on the GPU. One job at a time, others wait with status updates.
- **Per-project model specialisation**: Fine-tune separate LoRA adapters per
  project (zeveal, decorom, etc.) and swap them at runtime — each adapter is
  only ~50MB.
- **Long-term memory**: Store summaries of completed tasks in ChromaDB so the
  agent remembers "we use React Query for data fetching" without being told every time.
- **Reviewer agent**: Second LLM pass that checks the first agent's code changes
  before committing — catches obvious mistakes before the build runs.

---

## Summary: What makes this your competitive moat

| Feature | Open-source tools | Your custom system |
|---|---|---|
| Privacy | Cloud API required | 100% local |
| Cost | $19–39/dev/month | Free after hardware |
| Domain knowledge | Generic | Trained on your own code |
| Customisation | Limited | Full control |
| Data ownership | Vendor's servers | Your laptop |
