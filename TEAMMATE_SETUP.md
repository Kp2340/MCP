# AI Dev MCP — Teammate Setup Guide

## Why can't you just use Kush's server for your own projects?

Kush's MCP server at `https://ai.decorom.in` runs **on Kush's laptop**.
When it reads or writes files, it reads and writes **Kush's filesystem**.

If you send your local path like `C:\Users\Admin\Desktop\pratham-portfolio`,
that path doesn't exist on Kush's machine — so the server can't touch it.

This is by design. The whole point of the system is that **your code never
leaves your machine**. The MCP server runs locally, reads your local files,
and the AI talks to it remotely over a tunnel.

## The correct architecture

```
Claude / VS Code / IntelliJ
        │
        │  MCP tool calls over HTTPS
        ▼
https://your-tunnel-url.trycloudflare.com
        │
  Cloudflare tunnel
        │
        ▼
  YOUR Laptop — localhost:3001
  ├── MCP Server (node src/index.js)
  ├── ChromaDB
  └── Your projects (C:\Users\YourName\...)
```

Every developer runs their **own copy** of the MCP server on their **own laptop**.
The server reads YOUR files. Claude calls YOUR server.

---

## Step-by-step setup for a new teammate

### 1. Install prerequisites

| Tool | Install command |
|---|---|
| Node.js 20+ | https://nodejs.org |
| Ollama | https://ollama.ai |
| ChromaDB | `pip install chromadb` |
| Ripgrep | `winget install BurntSushi.ripgrep.MSVC` |
| Cloudflare tunnel | `winget install Cloudflare.cloudflared` |

### 2. Clone the MCP repo

```bat
git clone https://github.com/Kp2340/MCP.git
cd MCP
npm install
```

### 3. Create your .env

Copy `.env.example` to `.env` and fill in:

```env
PORT=3001
BASE_URL=https://YOUR-TUNNEL-URL.trycloudflare.com

# Your own API key — generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
API_KEYS=yourname:YOUR_GENERATED_KEY

DISABLE_REMOTE_REGISTER=false
ALLOWED_ROOTS=C:/Users/YourName
```

### 4. Add your project to projects.json

Edit `src/config/projects.json`:

```json
{
  "pratham-portfolio": {
    "root": "C:/Users/Admin/Desktop/Portfolio/pratham-portfolio",
    "type": "nextjs",
    "buildCommand": "npm run build",
    "branchPrefix": "PP"
  }
}
```

### 5. Start the server

Double-click `start-friend.bat` — it starts ChromaDB, the MCP server,
and a Cloudflare quick tunnel all in one go.

Your tunnel URL will appear in the console, e.g.:
```
https://wild-name-random.trycloudflare.com
```

### 6. Set your tunnel URL in .env and VS Code / IntelliJ

Update `BASE_URL` in `.env` to the tunnel URL printed above.

In VS Code settings (`Ctrl+,`, search "AI Dev MCP"):
- **Base URL**: `https://wild-name-random.trycloudflare.com`
- **API Key**: the key you put in `API_KEYS` above

### 7. Build the vector index for your project

```bat
node src/vector/runIndex.js pratham-portfolio
```

---

## Quick tunnel vs permanent tunnel

| | Quick tunnel (start-friend.bat) | Permanent tunnel (like Kush's) |
|---|---|---|
| Setup | Zero config | Cloudflare account + DNS record |
| URL | Random, changes on restart | Fixed (e.g. pratham.decorom.in) |
| Good for | Testing, occasional use | Daily driver |

For a permanent URL:
1. Create a free Cloudflare account
2. Add a subdomain (e.g. `pratham.decorom.in`) pointing to your tunnel
3. Follow https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

---

## Troubleshooting

**"Path does not exist on this server machine"**
You are pointing at Kush's server, not your own. Make sure your VS Code /
IntelliJ base URL points to YOUR tunnel URL, not `https://ai.decorom.in`.

**"Project not registered"**
Add your project to `src/config/projects.json` on your own machine.

**Ollama error**
Ollama runs as a background service automatically. Do NOT run `ollama serve`.
Just make sure Ollama is installed and run `ollama pull qwen2.5-coder:7b` once.
