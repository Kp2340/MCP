# AI Dev MCP — v5.4.0

A **local autonomous coding agent** that runs on your laptop and exposes 22 MCP tools to any AI IDE or model. Your code never leaves your machine.

---

## What it does

- Reads, edits, and commits code with targeted `str_replace` — no full rewrites
- Plans and executes multi-step tasks autonomously (plan → execute → review → validate)
- Searches your codebase semantically via ChromaDB vector embeddings
- Runs your build and auto-fixes compilation errors (up to 5 attempts)
- Runs your test suite and verifies fixes pass
- Stores long-term architecture memory per project
- Reviews its own changes mid-run and injects corrections
- Renames symbols safely across the whole project (AST-aware)
- Analyzes import dependency graph
- Persists jobs to disk — survives server restarts
- Streams live progress to IDEs via SSE
- Web UI dashboard at `/ui`

**LLM**: Ollama (local, primary) with automatic Gemini API fallback.

---

## Requirements

| Tool | Purpose | Install |
|---|---|---|
| Node.js 20+ | Runtime | https://nodejs.org |
| Ollama | Local LLM | https://ollama.ai |
| ChromaDB | Vector search | `pip install chromadb` |
| Ripgrep | Code search | `winget install BurntSushi.ripgrep.MSVC` |

---

## Quick start

```bat
git clone https://github.com/Kp2340/MCP.git
cd MCP
npm install
copy .env.example .env
```

Edit `.env` — set your API key and project paths. Then:

```bat
start-ai-dev.bat
```

This starts ChromaDB on port 8000, the MCP server on port 3001, and the agent CLI.

**First run — build the vector index for your project:**

```bat
node src/vector/runIndex.js <project-name>
```

---

## Project configuration

Edit `src/config/projects.json`:

```json
{
  "myapp": {
    "root": "C:/Users/you/IdeaProjects/myapp",
    "type": "nextjs",
    "buildCommand": "npm run build",
    "branchPrefix": "AI"
  }
}
```

Supported types: `nextjs`, `react-vite`, `nodejs`, `spring-boot`, `gradle`, `django`, `odoo`, `python`, `rails`, `go`, `rust`.

---

## MCP Tools (22 total)

| Tool | Purpose |
|---|---|
| `project_register` | Register a project by name + path |
| `project_scan` | List project files/folders |
| `project_read_files` | Read file contents |
| `project_str_replace` | Targeted search-and-replace edit (preferred for edits) |
| `project_apply_changes` | Write new files and commit |
| `project_apply_patch` | Apply a git unified diff patch |
| `project_search` | Ripgrep text search |
| `project_semantic_search` | Semantic vector search |
| `project_find_symbol` | Find class/function by name |
| `project_dependency_graph` | Import dependency analysis |
| `project_analyze` | Static analysis (broken imports, syntax errors) |
| `project_build` | Run project build |
| `project_build_and_fix` | Build + auto-fix errors (5 attempts) |
| `project_test` | Run test suite |
| `project_diff` | Show uncommitted git changes |
| `project_git_log` | Show recent commit history |
| `project_index` | Build/refresh semantic index |
| `project_rename_symbol` | Rename symbol in one file |
| `project_rename_symbol_all` | Rename symbol project-wide |
| `project_memory_store` | Store architecture pattern to memory |
| `project_memory_query` | Query long-term project memory |
| `project_list` | List all registered projects |

---

## HTTP endpoints

| Endpoint | Description |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (Claude Desktop, Cursor, Gemini CLI) |
| `GET /sse` | Legacy SSE MCP transport (older clients) |
| `POST /run` | Submit an agent task |
| `GET /status/:id` | Poll job status |
| `GET /stream/:id` | Live SSE progress stream |
| `GET /jobs` | List all jobs |
| `GET /diff/:id` | Git diff of completed job |
| `POST /revert/:id` | Revert agent changes |
| `GET /health` | Health check |
| `GET /ui` | Web dashboard |

---

## Security

- **Layer 1** — IP allowlist (`IP_ALLOWLIST` in `.env`)
- **Layer 2** — Per-user API keys (`API_KEYS=alice:key1,bob:key2`)
- **Layer 3** — Rate limiting per user on `/run`
- Path traversal protection on all file operations
- `ALLOWED_ROOTS` restricts which directories can be registered
- `DISABLE_REMOTE_REGISTER=true` locks down project registration completely

> **Note**: `/sse` and `/message` are unauthenticated by design (claude.ai web cannot send headers). Restrict these at the network layer (Cloudflare Access, Tailscale, or `IP_ALLOWLIST`) if the server is public.

---

## Environment variables

See `.env.example` for all options. Key ones:

```env
PORT=3001
API_KEYS=alice:your-key-here
OLLAMA_HOST=http://localhost:11434
LLM_MODEL=qwen2.5-coder:7b
GEMINI_API_KEY=           # optional fallback
CHROMA_HOST=localhost
CHROMA_PORT=8000
ALLOWED_ROOTS=C:/Users/you/IdeaProjects
DISABLE_REMOTE_REGISTER=false
```

---

## VS Code extension

Install from `vscode-extension/aidev-mcp-1.6.0.vsix`:

1. Open VS Code → Extensions → `...` → Install from VSIX
2. Settings → search `AI Dev MCP` → set Base URL + API Key
3. Open your project folder
4. `Ctrl+Shift+P` → `AI Dev MCP: Run Task`

Features: submit tasks, live SSE streaming, diff viewer with Accept/Reject, workspace sync, right-click actions.

---

## IntelliJ plugin

Install from `intellij-plugin/.intellijPlatform/sandbox/`:

1. Settings → Plugins → gear icon → Install Plugin from Disk
2. Settings → Tools → AI Dev MCP → set Server URL + API Key
3. Right sidebar: AI Dev MCP panel
4. Shortcut: `Ctrl+Shift+M`

Features: sidebar panel, inline right-click actions (Fix / Explain / Refactor / Write Tests), workspace sync, diff viewer.

---

## Teammate setup

See `TEAMMATE_SETUP.md` for step-by-step instructions to run your own server instance.
See `CONNECT.md` for connection instructions for all supported IDEs and clients.

---

## Architecture

```
IDE / AI Client
     |
     | MCP over HTTPS
     v
MCP Server (port 3001)
  |- /mcp   Streamable HTTP (modern)
  |- /sse   Legacy SSE (claude.ai web)
  |- /run   Agent job queue
  |- /ui    Web dashboard
     |
     v
Agent loop
  Planner -> Executor -> Self-critique -> Reviewer -> Validator
     |
     v
22 MCP Tools
  |- Filesystem / Git
  |- Build + Auto-fix
  |- ChromaDB (semantic search + memory)
  |- Ollama / Gemini (LLM)
```

---

## License

MIT — Author: Kp2340
