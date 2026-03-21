# AI Dev MCP

**Run AI coding tasks against your own codebase — locally, privately, with no cloud API costs.**

AI Dev MCP connects VS Code to a self-hosted coding agent powered by [Qwen2.5-Coder](https://ollama.com/library/qwen2.5-coder) running on [Ollama](https://ollama.com). Your code never leaves your machine.

---

## How it works

1. You run the [AI Dev MCP server](https://github.com/Kp2340/MCP) on any machine on your network (or locally)
2. The server indexes your codebase, runs the AI agent, and executes code changes
3. This extension connects to that server and streams live progress as the agent works

```
You type a prompt in VS Code
        ↓
Extension sends it to your server (POST /run)
        ↓
Qwen2.5-Coder reads your files, makes changes, commits
        ↓
Live output streams back to VS Code
```

---

## Features

- **Full codebase access** — the agent reads and edits your actual project files
- **Auto-detects project type** — Spring Boot, Liferay, React, Next.js, Django, Odoo, Go, and more
- **One-click setup** — just enter your server URL and API key
- **Live streaming** — watch every step as it happens in the output panel
- **Context injection** — select code before running and it’s automatically included in the prompt
- **Single commit** — all changes land in one git commit with your chosen message
- **No cloud required** — 100% local, runs on your own hardware
- **Keyboard shortcut** — `Ctrl+Shift+M` to run from anywhere

---

## Requirements

You need to run the AI Dev MCP server yourself. It takes about 10 minutes to set up:

1. Install [Node.js 20+](https://nodejs.org), [Ollama](https://ollama.com), and [ChromaDB](https://docs.trychroma.com)
2. Pull the model: `ollama pull qwen2.5-coder:7b`
3. Clone and start the server:
   ```bash
   git clone https://github.com/Kp2340/MCP
   cd MCP
   npm install
   cp .env.example .env   # edit: set API_KEY
   node src/index.js
   ```
4. The server runs on `http://localhost:3001` by default

See the [full setup guide](https://github.com/Kp2340/MCP#readme) for team/network deployment.

---

## Extension setup

After installing this extension, open VS Code Settings (`Ctrl+,`) and search **aidevmcp**:

| Setting | Description | Example |
|---|---|---|
| `aidevmcp.baseUrl` | Your server URL | `http://localhost:3001` |
| `aidevmcp.apiKey` | API key from your server `.env` | `my-secret-key` |
| `aidevmcp.defaultProject` | Leave empty (auto-detected) | *(blank)* |

---

## Usage

**Run a task:**
1. Open a project folder in VS Code
2. Press `Ctrl+Shift+M` (or right-click → **MCP: Run AI Prompt**)
3. Confirm the project name (auto-detected from folder name)
4. Type your prompt, e.g.:
   - `Analyse the project and fix any minor issues, commit as "Issues fixed"`
   - `Add a REST endpoint for user search`
   - `Refactor the auth module to use JWT`
5. Watch the **AI Dev MCP** output panel for live progress

**Select code for context:**
Highlight any code before running a prompt — it gets injected automatically.

**Commands** (Command Palette `Ctrl+Shift+P`):
- `MCP: Run AI Prompt` — run a task
- `MCP: Check Job Status` — check a running job by ID
- `MCP: List All Jobs` — see job history
- `MCP: Queue Status` — see the job queue depth

---

## Supported project types

The server auto-detects your project from signature files:

| Project type | Detected from |
|---|---|
| Spring Boot | `pom.xml` |
| Liferay | `build.gradle` + liferay references |
| React / Vite | `package.json` + vite dependency |
| Next.js | `package.json` + next dependency |
| Node.js | `package.json` |
| Django | `manage.py` |
| Odoo | `manage.py` + `__manifest__.py` |
| Python | `requirements.txt` / `setup.py` |
| Go | `go.mod` |
| Rust | `Cargo.toml` |

---

## Privacy

Your code is processed entirely on your own machine or your team’s private server. Nothing is sent to any external AI service. The extension only communicates with the server URL you configure.

---

## Links

- [GitHub — server source code](https://github.com/Kp2340/MCP)
- [Issues and feature requests](https://github.com/Kp2340/MCP/issues)
- [Ollama](https://ollama.com) — local LLM runtime
- [Qwen2.5-Coder](https://ollama.com/library/qwen2.5-coder) — the AI model used
