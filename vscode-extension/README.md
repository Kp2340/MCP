# AI Dev MCP — Plugin & Client System

Complete client SDK and IDE integrations for the AI Dev MCP server.

---

## What's Included

```
mcp-plugin/
├── src/
│   └── client/
│       └── mcpClient.js          ← Universal JS SDK (Node + browser, zero deps)
├── vscode-extension/
│   ├── extension.js              ← Full VS Code extension
│   ├── package.json              ← Extension manifest
│   └── README.md                 ← Setup + packaging instructions
├── intellij-plugin/
│   └── ARCHITECTURE.md           ← Full Kotlin plugin code + build guide
└── example.js                    ← SDK usage examples
```

---

## 1 — JavaScript Client SDK

**File:** `src/client/mcpClient.js`  
Zero dependencies. Works in Node.js 18+ and modern browsers.

```js
import { MCPClient } from "./src/client/mcpClient.js";

const client = new MCPClient({
    baseUrl: "https://your-ngrok-url.ngrok.io",  // or custom domain
    apiKey:  "your-api-key",
});

// Submit a task
const jobId = await client.runTask("Fix login bug", "jsv");

// Stream live logs
await client.stream(jobId, (msg) => {
    if (msg.event === "completed") console.log("Done!", msg.data);
    else console.log(`[${msg.data?.step}] ${msg.data?.log}`);
});

// OR: wait for completion (stream → poll fallback)
const result = await client.waitForCompletion(jobId, console.log);
```

### Environment variable support

```bash
MCP_BASE_URL=https://your-ngrok-url.ngrok.io
MCP_API_KEY=your-api-key
```

```js
import { createClientFromEnv } from "./src/client/mcpClient.js";
const client = createClientFromEnv();
```

### Full API

| Method | Description |
|---|---|
| `runTask(prompt, project)` | Submit task → returns jobId |
| `getStatus(jobId)` | Fetch job status object |
| `listJobs(statusFilter?)` | List all jobs |
| `getQueue()` | Get queue depth |
| `stream(jobId, onMessage)` | Subscribe to SSE stream |
| `waitForCompletion(jobId, onProgress?)` | Wait for terminal state |

---

## 2 — VS Code Extension

### Install (teammates)

```bash
# Package (one time, from your machine)
cd vscode-extension
npm install
npx vsce package
# → aidev-mcp-1.0.0.vsix

# Install (on teammate's machine)
code --install-extension aidev-mcp-1.0.0.vsix
```

### Configure

Settings → search **aidevmcp**:

| Setting | Value |
|---|---|
| `aidevmcp.baseUrl` | `https://your-ngrok-url.ngrok.io` |
| `aidevmcp.apiKey` | Your API key |
| `aidevmcp.defaultProject` | e.g. `jsv` |

### Use

- **Ctrl+Shift+M** → prompts for project + task
- Highlight code first → it's injected as context automatically
- Logs stream live in the **AI Dev MCP** output panel
- Status bar shows running / idle state

---

## 3 — IntelliJ Plugin

See `intellij-plugin/ARCHITECTURE.md` for complete Kotlin source code.

**Build:**
```bash
cd intellij-plugin
./gradlew buildPlugin
# → build/distributions/aidev-mcp-1.0.0.zip
```

**Install internally (no Marketplace):**  
Settings → Plugins → ⚙ → Install Plugin from Disk → select the `.zip`

---

## 4 — SSE Stream Format

The server emits standard SSE events:

```
event: message
data: {"step": 1, "log": "Reading files..."}

event: message
data: {"step": 2, "log": "Applying changes..."}

event: completed
data: {"id": "job_abc", "status": "completed", "result": "..."}

event: failed
data: {"id": "job_abc", "status": "failed", "error": "..."}

:heartbeat
```

Every 15 seconds a heartbeat (`:heartbeat`) keeps the connection alive through proxies and ngrok.

---

## 5 — Endpoints Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/run` | x-api-key | Submit a job |
| GET | `/status/:id` | x-api-key | Get job status |
| GET | `/stream/:id` | x-api-key | SSE stream for a job |
| GET | `/jobs` | x-api-key | List all jobs |
| GET | `/queue` | x-api-key | Queue depth |
| GET | `/health` | none | Health check |

---

## 6 — Generic Integration (any IDE)

For any IDE that supports HTTP + plugins:

```
POST /run
Headers: x-api-key: <key>, Content-Type: application/json
Body: { "prompt": "...", "project": "jsv" }
→ { "id": "job_xxx", "streamUrl": "/stream/job_xxx" }

GET /stream/job_xxx
Headers: x-api-key: <key>, Accept: text/event-stream
→ SSE stream (parse event: / data: lines)
```

---

## Security Notes

- The API key is validated on every request server-side
- Share the `.vsix` / `.zip` plugin files with teammates — **not** the API key in plaintext
- Each teammate adds the key in their local IDE settings
- Rotate the key in your `.env` if compromised (restart the server)
