# AI Dev MCP — Connection Guide

This guide covers how to start the server and connect every supported client.

---

## 1. Start the server

```bat
start-ai-dev.bat
```

Or individually:

```bat
# Terminal 1 — ChromaDB
chroma run --host localhost --port 8000

# Terminal 2 — MCP server
node src/index.js
```

Verify it's running: http://localhost:3001/health

Public tunnel (optional, for remote access):

```bat
cloudflared tunnel --url http://localhost:3001
```

The tunnel prints a URL like `https://xyz.trycloudflare.com` — use that as your base URL.

---

## 2. Get your API key

Generate a key:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add it to `.env`:

```env
API_KEYS=yourname:paste-key-here
```

Restart the server after changing `.env`.

---

## 3. Register your project

Either add it to `src/config/projects.json`:

```json
{
  "myapp": {
    "root": "C:/Projects/myapp",
    "type": "nextjs",
    "buildCommand": "npm run build"
  }
}
```

Or tell any connected AI to call the `project_register` tool:

```
Register project: name=myapp, path=C:/Projects/myapp
```

---

## Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-dev-mcp": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

For a remote/tunnel server:

```json
{
  "mcpServers": {
    "ai-dev-mcp": {
      "url": "https://your-tunnel.trycloudflare.com/sse"
    }
  }
}
```

Restart Claude Desktop. The tools appear automatically.

> No API key needed for `/sse` — it is unauthenticated by design (Claude Desktop cannot send custom headers).

---

## Cursor

1. Open Cursor Settings → MCP
2. Add server:
   - **Type**: HTTP
   - **URL**: `http://localhost:3001/mcp`
   - **Header**: `x-api-key: your-key`
3. Save and reload

Alternatively, edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-dev-mcp": {
      "url": "http://localhost:3001/mcp",
      "headers": { "x-api-key": "your-key" }
    }
  }
}
```

---

## Windsurf

1. Windsurf Settings → MCP Servers → Add
2. **URL**: `http://localhost:3001/mcp`
3. **Headers**: `x-api-key: your-key`

Or edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ai-dev-mcp": {
      "serverUrl": "http://localhost:3001/mcp",
      "headers": { "x-api-key": "your-key" }
    }
  }
}
```

---

## Gemini CLI

```bash
gem mcp add ai-dev-mcp http://localhost:3001/mcp --header "x-api-key=your-key"
```

Or add to `~/.gemini/mcp.json`:

```json
{
  "servers": [
    {
      "name": "ai-dev-mcp",
      "url": "http://localhost:3001/mcp",
      "headers": { "x-api-key": "your-key" }
    }
  ]
}
```

---

## Claude CLI / Claude Code

```bash
claude mcp add ai-dev-mcp http://localhost:3001/mcp --header "x-api-key=your-key"
```

Or using `mcp-remote` for SSE:

```bash
claude mcp add ai-dev-mcp \
  --transport sse \
  --url http://localhost:3001/sse
```

---

## Codex CLI

Add to your Codex config file (`~/.codex/config.json` or equivalent):

```json
{
  "plugins": [
    {
      "name": "ai-dev-mcp",
      "mcp": {
        "transport": "http",
        "url": "http://localhost:3001/mcp",
        "headers": { "x-api-key": "your-key" }
      }
    }
  ]
}
```

---

## VS Code Extension

**Install:**
1. Extensions panel → `...` → Install from VSIX
2. Select `vscode-extension/aidev-mcp-1.6.0.vsix`

**Configure:**
- Open Settings (`Ctrl+,`) → search `AI Dev MCP`
- **Base URL**: `http://localhost:3001` (or your tunnel URL)
- **API Key**: your key from `.env`

**Use:**
- `Ctrl+Shift+P` → `AI Dev MCP: Run Task` — submit a prompt
- Right-click any code → AI Dev MCP → Fix / Explain / Refactor / Write Tests
- Status bar shows server connection state
- Diff viewer with Accept / Reject after each task
- Workspace Sync — push local folder, run agent, pull changes back

**Commands available:**
- `AI Dev MCP: Run Task` — submit natural language task
- `AI Dev MCP: Show Jobs` — view job history
- `AI Dev MCP: Sync Workspace` — push/pull workspace
- `AI Dev MCP: Show Diff` — review latest changes

---

## IntelliJ Plugin

**Install:**
1. Settings → Plugins → gear icon → Install Plugin from Disk
2. Select the latest `.vsix` from `intellij-plugin/` folder
   (or from JetBrains Marketplace if published)

**Configure:**
1. Settings → Tools → AI Dev MCP
2. **Server URL**: `http://localhost:3001` (or your tunnel URL)
3. **API Key**: your key from `.env`

**Use:**
- Right sidebar: AI Dev MCP panel — type prompt, click Run
- Shortcut: `Ctrl+Shift+M` — run a prompt
- Right-click any code in editor:
  - **Fix with MCP** (`Ctrl+Shift+F10`)
  - **Explain with MCP** (`Ctrl+Shift+F11`)
  - **Refactor with MCP** (`Ctrl+Shift+F12`)
  - **Write Tests with MCP**
- Tools menu → AI Dev MCP → same actions
- Workspace Sync button in the panel — zip, upload, run, pull
- Diff viewer with Accept / Revert buttons after each task

**Project auto-detection:** The plugin reads your IntelliJ project path automatically — no configuration needed.

---

## Web UI

Open http://localhost:3001/ui in any browser.

Features:
- Submit tasks with project path + prompt
- Live SSE output stream
- Job history with status
- Diff viewer with Accept / Reject
- Server health stats

> The web UI does not require an API key when accessed from localhost.

---

## Troubleshooting

**"Project not found"** — Add it to `src/config/projects.json` or call `project_register`.

**"No results" from semantic search** — Run `node src/vector/runIndex.js <project-name>` to build the index.

**Ollama error** — Run `ollama pull qwen2.5-coder:7b` once. Do not run `ollama serve` manually.

**ChromaDB error** — Run `chroma run --host localhost --port 8000` in a separate terminal, or use `start-ai-dev.bat`.

**Connection refused on tunnel** — The tunnel URL changes on every restart of `start-friend.bat`. Update your client's base URL.

**401 Unauthorized** — Check your `API_KEYS` in `.env` and the `x-api-key` header in your client.
