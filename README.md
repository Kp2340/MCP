# AI Dev MCP — v9.0.0

Local autonomous coding environment. An AI agent that can explore, modify, build,
and auto-fix real software projects using the Model Context Protocol (MCP) —
running 100% on your own hardware with no cloud API required.

---

## What's new in v9

- **All bugs fixed** — `project_find_symbol` now returns correct names, `node_modules` never indexed
- **Shell injection removed** — all git commands use `spawnSync` with args arrays
- **`autoFixLoop` sends file context** — error fixes are now accurate instead of blind
- **Centralised `extractJSON`** — reliable JSON parsing across all LLM callers
- **Build timeout** — 120s cap prevents infinite hangs
- **Hot-reload project registry** — add projects without restarting
- **Training data collector** — every successful run auto-saved for future fine-tuning
- **`project_list` tool** — agents can discover projects without hardcoding

---

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime |
| Ollama | latest | Local LLM inference |
| ChromaDB | latest | Vector database |
| Ripgrep | latest | Fast code search |

### Install

```bash
# Ripgrep (Windows)
winget install BurntSushi.ripgrep.MSVC

# ChromaDB
pip install chromadb

# Ollama model
ollama pull qwen2.5-coder:7b

# Project dependencies
git clone https://github.com/kp2340/mcp
cd mcp
npm install
```

---

## Quick start

```bash
# 1. Add your projects to:
src/config/projects.json

# 2. Build vector index for a project
npm run index <project-name>

# 3. Start everything
start-ai-dev.bat

# 4. Enter a prompt
project: my-project, task: add a password reset page
```

---

## Project configuration

Edit `src/config/projects.json`. Changes take effect immediately — no restart needed.

```json
{
  "my-app": {
    "root": "C:/Users/yourname/IdeaProjects/my-app",
    "type": "react-vite",
    "buildCommand": "npm run build",
    "branchPrefix": "MA"
  },
  "my-backend": {
    "root": "C:/Users/yourname/IdeaProjects/my-backend",
    "type": "spring-boot",
    "buildCommand": "mvn clean install",
    "branchPrefix": "MB"
  }
}
```

Supported project types: `react-vite`, `nextjs`, `spring-boot`, `liferay-backend`

---

## Available MCP tools

| Tool | What it does |
|------|-------------|
| `project_list` | List all configured projects |
| `project_scan` | List files and folders |
| `project_search` | Ripgrep text search across source files |
| `project_read_files` | Read file contents (up to 12KB each) |
| `project_find_symbol` | Find classes/functions by name (AST-based) |
| `project_apply_changes` | Write files and git commit |
| `project_apply_patch` | Apply a git diff patch |
| `project_build` | Run the project's build command |
| `project_build_and_fix` | Build + auto-fix errors (up to 5 attempts) |
| `project_index` | Build AST symbol index |
| `project_dependency_graph` | Analyse import/require graph |

---

## Team hosting

Your laptop can serve the MCP for 1–2 teammates simultaneously.

**Over LAN:** teammates point their MCP client at `http://your-laptop-ip:3001`
(requires adding the HTTP/SSE transport — see `ROADMAP.md` Phase 2a).

**Over internet:** install [Tailscale](https://tailscale.com) (free) — no
firewall config needed, works from anywhere.

**Capacity on your hardware:**
- 1 user at a time: smooth (~20–30 tok/s on RTX 3050 Ti)
- 2 concurrent: requests queue, each waits ~30–60s

---

## Building your own private model

Every successful agent run is automatically saved to `src/training/dataset/runs.jsonl`.
Once you have 50+ examples, run the fine-tuning script:

```bash
# Install Python deps (one time)
pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
pip install trl datasets transformers accelerate bitsandbytes

# Fine-tune (2–4 hours on RTX 3050 Ti)
python src/training/finetune.py

# Register the resulting model with Ollama
echo 'FROM ./my-coder-model-Q4_K_M.gguf' > Modelfile
ollama create company-coder -f Modelfile
```

Then change one line in `src/agent/ollamaClient.js`:
```js
const MODEL = "company-coder";
```

Your model will know your codebase, your conventions, and your tools — without
any code or data ever leaving your network.

See `ROADMAP.md` for the full plan.

---

## Project structure

```
src/
├── agent/
│   ├── agent.js          ← CLI entry point
│   ├── planner.js        ← Creates numbered task plans
│   ├── executor.js       ← Converts steps → tool calls
│   ├── retriever.js      ← Vector context retrieval
│   ├── mcpClient.js      ← Talks to MCP server
│   └── ollamaClient.js   ← Shared LLM caller (temperature enforced)
│
├── analysis/
│   └── dependencyGraph.js
│
├── autoFixLoop/
│   └── autoFixLoop.js    ← Build → parse errors → LLM fix → repeat
│
├── build/
│   ├── buildProject.js   ← exec with 120s timeout
│   └── parseBuildErrors.js
│
├── config/
│   └── projects.json     ← Add your projects here
│
├── core/
│   ├── constants.js      ← IGNORE_FOLDERS, MAX_FILE_SIZE, BUILD_TIMEOUT_MS
│   ├── projectRegistry.js ← Hot-reload project config
│   └── validator.js      ← Path safety + commit message sanitisation
│
├── git/
│   ├── branch.js
│   └── commit.js
│
├── indexer/
│   ├── languageLoader.js  ← Cached tree-sitter parsers
│   └── semanticIndexer.js ← AST symbol extraction (fixed node names)
│
├── tools/                 ← One file per MCP tool
│   ├── applyChanges.js
│   ├── projectBuild.js
│   ├── projectFindSymbol.js
│   ├── projectIndex.js
│   ├── projectPatch.js
│   ├── projectSearch.js
│   ├── readFiles.js
│   └── scanProject.js
│
├── training/
│   ├── collector.js       ← Auto-saves successful runs as training data
│   ├── finetune.py        ← Fine-tune on RTX 3050 Ti with Unsloth
│   └── dataset/
│       └── runs.jsonl     ← Grows automatically as you use the agent
│
├── utils/
│   ├── fileUtils.js
│   └── jsonUtils.js       ← extractJSON + safeParse (shared by all LLM callers)
│
├── vector/
│   ├── embedder.js
│   ├── indexCodebase.js
│   ├── queryCodebase.js
│   ├── runIndex.js
│   └── runIndexCore.js
│
└── index.js               ← MCP server (v9.0.0)
```

---

## Troubleshooting

**ChromaDB collection error** — rebuild the index:
```bash
npm run index <project-name>
```

**Ollama port error** — Ollama runs as a background service, do NOT run `ollama serve` manually.

**`project_find_symbol` returns nothing** — run `project_index` first, or it will auto-build on first use.

**Build hangs** — now capped at 120s and will report a timeout error automatically.

---

## License

MIT — Kp2340
