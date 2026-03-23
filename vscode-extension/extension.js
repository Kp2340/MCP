// AI Dev MCP — VS Code Extension v1.5.0
// v1.5.0: workspace sync — push local folder to remote server, run job, pull changes back
//         so remote users can use a shared server without running their own instance

"use strict";
const vscode = require("vscode");

const DEFAULT_POLL_MS    = 2000;
const DEFAULT_TIMEOUT_MS = 300_000;
const HEALTH_INTERVAL_MS = 60_000;

// ─── MCPClient ────────────────────────────────────────────────────────────────
class MCPClient {
    constructor({ baseUrl, apiKey, timeout, pollInterval } = {}) {
        if (!baseUrl) throw new Error("MCPClient: baseUrl is required");
        if (!apiKey)  throw new Error("MCPClient: apiKey is required");
        this.baseUrl      = baseUrl.replace(/\/$/, "");
        this.apiKey       = apiKey;
        this.timeout      = timeout      ?? DEFAULT_TIMEOUT_MS;
        this.pollInterval = pollInterval ?? DEFAULT_POLL_MS;
    }

    _headers() {
        return { "Content-Type": "application/json", "x-api-key": this.apiKey };
    }

    async _json(path, opts = {}) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            ...opts,
            headers: { ...this._headers(), ...(opts.headers || {}) },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`MCP ${opts.method || "GET"} ${path} → ${res.status}: ${body}`);
        }
        return res.json();
    }

    async health()              { return this._json("/health"); }
    async runTask(prompt, path) { return this._json("/run", { method: "POST", body: JSON.stringify({ prompt, path }) }); }
    async getStatus(id)         { return this._json(`/status/${id}`); }
    async getDiff(id)           { return this._json(`/diff/${id}`); }
    // safe=true  → git revert HEAD (creates undo commit, safe)
    // safe=false → git reset --hard HEAD~1 (destructive)
    async revert(id, hard = false) {
        const qs = hard ? "?hard=true" : "";
        return this._json(`/revert/${id}${qs}`, { method: "POST", body: "{}" });
    }
    async listJobs(status)      { return this._json(`/jobs${status ? `?status=${status}` : ""}`); }
    async getQueue()            { return this._json("/queue"); }

    // ── Workspace sync ───────────────────────────────────────────────────────
    // Push a zip buffer to the server; returns { project, fileCount, message }
    async pushWorkspace(projectName, zipBuffer) {
        const url  = `${this.baseUrl}/workspace/push?project=${encodeURIComponent(projectName)}`;
        const res  = await fetch(url, {
            method:  "POST",
            headers: { "x-api-key": this.apiKey, "Content-Type": "application/octet-stream" },
            body:    zipBuffer,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Push failed ${res.status}: ${body}`);
        }
        return res.json();
    }

    // Pull changed files as zip ArrayBuffer
    async pullWorkspace(projectName) {
        const url = `${this.baseUrl}/workspace/pull/${encodeURIComponent(projectName)}`;
        const res = await fetch(url, { headers: { "x-api-key": this.apiKey } });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Pull failed ${res.status}: ${body}`);
        }
        return res.arrayBuffer();
    }

    async deleteWorkspace(projectName) {
        return this._json(`/workspace/${encodeURIComponent(projectName)}`, { method: "DELETE" });
    }

    async stream(jobId, onMessage) {
        const res = await fetch(`${this.baseUrl}/stream/${jobId}`, {
            headers: { ...this._headers(), Accept: "text/event-stream" },
        });
        if (!res.ok) throw new Error(`Stream ${res.status}`);
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split("

");
            buf = parts.pop();
            for (const block of parts) {
                let event = "message", data = null;
                for (const line of block.split("
")) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    if (line.startsWith("data:"))  data  = line.slice(5).trim();
                }
                if (data && !data.startsWith(":")) {
                    try { onMessage({ event, data: JSON.parse(data) }); }
                    catch { onMessage({ event, data }); }
                }
            }
        }
    }

    async waitForCompletion(jobId, onProgress) {
        return new Promise(async (resolve, reject) => {
            const tid = setTimeout(() => reject(new Error(`Timed out after ${this.timeout}ms`)), this.timeout);
            try {
                await this.stream(jobId, msg => {
                    if (onProgress) onProgress(msg);
                    if (msg.event === "completed") { clearTimeout(tid); resolve(msg.data); }
                    if (msg.event === "failed")    { clearTimeout(tid); reject(new Error(JSON.stringify(msg.data))); }
                });
                clearTimeout(tid);
            } catch {
                clearTimeout(tid);
                try {
                    const deadline = Date.now() + this.timeout;
                    while (Date.now() < deadline) {
                        const job = await this.getStatus(jobId);
                        if (onProgress) onProgress({ event: "poll", data: job });
                        if (job.status === "completed") { clearTimeout(tid); return resolve(job); }
                        if (job.status === "failed")    { clearTimeout(tid); return reject(new Error(job.error)); }
                        await new Promise(r => setTimeout(r, this.pollInterval));
                    }
                    reject(new Error("Polling timed out"));
                } catch (e) { clearTimeout(tid); reject(e); }
            }
        });
    }
}

// ─── Zip helpers (Node built-ins only, no extra deps) ────────────────────────
// We use the system `powershell Compress-Archive` on Windows to create zips
// and `Expand-Archive` to extract them. This avoids any npm dependency.
const cp   = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

function zipFolder(srcDir, destZip) {
    return new Promise((resolve, reject) => {
        const ps = cp.spawn("powershell", [
            "-NoProfile", "-Command",
            `Compress-Archive -Force -Path '${srcDir}\\*' -DestinationPath '${destZip}'`
        ]);
        ps.on("close", code => code === 0 ? resolve() : reject(new Error(`zip exit ${code}`)));
    });
}

function unzipTo(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        const ps = cp.spawn("powershell", [
            "-NoProfile", "-Command",
            `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`
        ]);
        ps.on("close", code => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`)));
    });
}

// ─── Extension state ──────────────────────────────────────────────────────────
let out;           // OutputChannel
let bar;           // StatusBarItem
let panel = null;  // WebviewPanel
let client = null;
let healthTimer = null;

function cfg()        { return vscode.workspace.getConfiguration("aidevmcp"); }
function log(msg)     { const t = new Date().toISOString().slice(0,19).replace("T"," "); out.appendLine(`[${t}] ${msg}`); }
function wsPath()     { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null; }
function projName()   {
    const override = cfg().get("defaultProject");
    if (override) return override.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const p = wsPath();
    return p ? path.basename(p).toLowerCase().replace(/[^a-z0-9_-]/g, "-") : null;
}

// ─── Workspace sync commands ──────────────────────────────────────────────────

/** Push the current workspace folder to the remote server as a zip, then optionally run a prompt. */
async function cmdSyncWorkspace() {
    const localDir = wsPath();
    if (!localDir) { vscode.window.showErrorMessage("Open a folder first (File > Open Folder)"); return; }
    const c = buildClient();
    if (!c) { vscode.window.showErrorMessage("Set your API key in Settings > AI Dev MCP"); return; }
    const project = projName();

    const prompt = await vscode.window.showInputBox({
        prompt: `Prompt for the AI agent (project: ${project}) — leave empty to just sync files`,
        placeHolder: "e.g. Add a contact form to the homepage",
    });
    if (prompt === undefined) return; // cancelled

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `MCP Sync: ${project}`,
        cancellable: false,
    }, async progress => {
        const tmpZip = path.join(os.tmpdir(), `mcp-${project}-${Date.now()}.zip`);
        try {
            // 1. Zip the workspace
            progress.report({ message: "Zipping workspace..." });
            await zipFolder(localDir, tmpZip);
            const zipBuffer = fs.readFileSync(tmpZip);
            log(`Pushing ${project} to server (${(zipBuffer.length / 1024).toFixed(0)} KB)...`);

            // 2. Push to server
            progress.report({ message: "Uploading to server..." });
            const pushResult = await c.pushWorkspace(project, zipBuffer);
            log(`Push OK: ${pushResult.fileCount} files on server`);

            if (!prompt) {
                vscode.window.showInformationMessage(`✓ Synced ${pushResult.fileCount} files to server as "${project}". No prompt given — files are ready for future jobs.`);
                return;
            }

            // 3. Submit the job
            progress.report({ message: "Running AI agent..." });
            const job = await c.runTask(prompt, project);
            log(`Job started: ${job.id}`);

            // 4. Stream progress
            progress.report({ message: `Job ${job.id} running...` });
            await c.waitForCompletion(job.id, msg => {
                if (msg.event === "step") {
                    const txt = msg.data?.message || msg.data || "";
                    progress.report({ message: String(txt).slice(0, 80) });
                    log(`step: ${txt}`);
                }
            });

            // 5. Pull changes back
            progress.report({ message: "Downloading changes..." });
            const zipAb  = await c.pullWorkspace(project);
            const outZip = path.join(os.tmpdir(), `mcp-${project}-pull-${Date.now()}.zip`);
            fs.writeFileSync(outZip, Buffer.from(zipAb));
            await unzipTo(outZip, localDir);
            fs.unlinkSync(outZip);

            log(`Pull complete — changes applied to ${localDir}`);
            vscode.window.showInformationMessage(`✓ Agent finished. Changes applied to your workspace.`);
        } catch (err) {
            log(`syncWorkspace error: ${err.message}`);
            vscode.window.showErrorMessage(`MCP Sync failed: ${err.message}`);
        } finally {
            try { fs.unlinkSync(tmpZip); } catch {}
        }
    });
}

/** Pull latest files from the server workspace back to the local folder (without running a job). */
async function cmdPullWorkspace() {
    const localDir = wsPath();
    if (!localDir) { vscode.window.showErrorMessage("Open a folder first"); return; }
    const c = buildClient();
    if (!c) { vscode.window.showErrorMessage("Set your API key in Settings > AI Dev MCP"); return; }
    const project = projName();

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `MCP Pull: ${project}`,
        cancellable: false,
    }, async progress => {
        try {
            progress.report({ message: "Downloading from server..." });
            const zipAb  = await c.pullWorkspace(project);
            const outZip = path.join(os.tmpdir(), `mcp-${project}-pull-${Date.now()}.zip`);
            fs.writeFileSync(outZip, Buffer.from(zipAb));
            await unzipTo(outZip, localDir);
            fs.unlinkSync(outZip);
            log(`Pull complete for ${project}`);
            vscode.window.showInformationMessage(`✓ Changes pulled from server into your workspace.`);
        } catch (err) {
            log(`pullWorkspace error: ${err.message}`);
            vscode.window.showErrorMessage(`MCP Pull failed: ${err.message}`);
        }
    });
}

function buildClient() {
    const c = cfg();
    const url = c.get("baseUrl") || process.env.MCP_BASE_URL || "https://ai.decorom.in";
    const key = c.get("apiKey")  || process.env.MCP_API_KEY  || "";
    if (!key) return null;   // URL has a sensible default; key is always required
    return new MCPClient({ baseUrl: url, apiKey: key });
}

function setBar(text, tip, color) {
    bar.text    = text;
    bar.tooltip = tip   ?? "AI Dev MCP";
    bar.color   = color ?? new vscode.ThemeColor("statusBar.foreground");
    bar.show();
}

// ─── Health check ─────────────────────────────────────────────────────────────
async function checkHealth() {
    const url = cfg().get("baseUrl") || process.env.MCP_BASE_URL || "https://ai.decorom.in";
    if (!url) { setBar("$(plug) MCP", "Set baseUrl in Settings → AI Dev MCP"); return; }
    try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            setBar("$(circle-filled) MCP", "AI Dev MCP — server connected",
                new vscode.ThemeColor("terminal.ansiGreen"));
        } else {
            setBar("$(warning) MCP", `Server returned ${res.status}`);
        }
    } catch {
        setBar("$(error) MCP", `Cannot reach ${url}`,
            new vscode.ThemeColor("errorForeground"));
    }
}

// ─── Editor context helpers ───────────────────────────────────────────────────
function getEditorCtx() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return null;
    const doc = ed.document, sel = ed.selection;
    return {
        filePath:     doc.uri.fsPath,
        language:     doc.languageId,
        selectedText: sel.isEmpty ? null : doc.getText(sel),
        line:         sel.active.line + 1,
    };
}

// Prepend selected code + file context to every user prompt
function enrichPrompt(raw) {
    const ctx = getEditorCtx();
    if (!ctx) return raw;
    const parts = [];
    if (ctx.filePath)     parts.push(`[File: ${ctx.filePath}]`);
    if (ctx.selectedText) parts.push(
        `[Selected ${ctx.language} — line ${ctx.line}]:
\`\`\`${ctx.language}
${ctx.selectedText.substring(0, 2000)}
\`\`\``
    );
    return parts.length ? `${parts.join("
")}

${raw}` : raw;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────
function getPanelHtml(projectName) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;background:var(--vscode-editor-background);color:var(--vscode-foreground);display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:8px;flex-shrink:0}
#header .title{font-weight:600;font-size:13px;flex:1}
#header .badge{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
#tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.tab{padding:7px 16px;cursor:pointer;font-size:12px;opacity:.65;border-bottom:2px solid transparent;user-select:none}
.tab.active{opacity:1;border-bottom-color:var(--vscode-focusBorder)}
.tab:hover{opacity:1}
#tab-chat,#tab-diff,#tab-history{flex:1;overflow:hidden;display:none;flex-direction:column}
#tab-chat.visible,#tab-diff.visible,#tab-history.visible{display:flex}
#messages{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;flex-direction:column;gap:3px}
.msg .role{font-size:11px;font-weight:600;opacity:.55;text-transform:uppercase;letter-spacing:.5px}
.msg.user .role{color:var(--vscode-textLink-foreground)}
.msg.agent .role{color:#4ec9b0}
.msg.step .role{color:#dcdcaa}
.msg.error .role{color:var(--vscode-errorForeground)}
.msg.reviewer .role{color:#c586c0}
.msg .body{line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.step .body{opacity:.75;font-size:12px}
.divider{border:none;border-top:1px solid var(--vscode-panel-border);margin:4px 0}
.spinner{display:inline-block;width:10px;height:10px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
#input-row{padding:10px 14px;border-top:1px solid var(--vscode-panel-border);display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
#prompt-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:7px 10px;font-family:inherit;font-size:13px;resize:none;min-height:36px;max-height:120px;outline:none}
#prompt-input:focus{border-color:var(--vscode-focusBorder)}
#send-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:7px 14px;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}
#send-btn:hover{background:var(--vscode-button-hoverBackground)}
#send-btn:disabled{opacity:.5;cursor:not-allowed}
#diff-header{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
.commit-msg{font-size:12px;flex:1;opacity:.85;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn-accept{background:#16825d;color:#fff;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px}
.btn-accept:hover{background:#1a9e6e}
.btn-reject{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-errorForeground,#f48771);border:1px solid var(--vscode-inputValidation-errorBorder,#f48771);border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px}
.btn-reject:hover{opacity:.85}
#file-list{padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0}
.file-pill{font-size:11px;padding:2px 8px;border-radius:10px;cursor:pointer}
.file-pill.M{background:#1f3a5f;color:#4fc1ff}
.file-pill.A{background:#163a1e;color:#4ec9b0}
.file-pill.D{background:#3a1616;color:#f48771}
#diff-content{flex:1;overflow-y:auto}
.diff-file-block{margin:0}
.diff-file-name{padding:6px 14px;font-size:11px;font-weight:600;background:var(--vscode-editorGroupHeader-tabsBackground);border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-tab-activeForeground)}
.diff-line{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;padding:1px 14px;white-space:pre;overflow-x:auto}
.diff-line.add{background:rgba(78,201,112,.1);color:#4ec9b0}
.diff-line.del{background:rgba(244,135,113,.1);color:#f48771}
.diff-line.meta{opacity:.4;font-size:11px}
#history-list{flex:1;overflow-y:auto;padding:8px}
.hist-row{padding:8px 10px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px}
.hist-row:hover{background:var(--vscode-list-hoverBackground)}
.hist-status{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.hist-status.completed{background:#4ec9b0}
.hist-status.failed{background:#f48771}
.hist-status.pending,.hist-status.running{background:#dcdcaa}
.hist-info{flex:1;overflow:hidden}
.hist-prompt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.hist-meta{font-size:11px;opacity:.55;margin-top:2px}
.hist-diff-btn{font-size:11px;padding:2px 8px;border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;cursor:pointer}
</style>
</head>
<body>
<div id="header">
  <span class="title">AI Dev MCP</span>
  <span class="badge" id="project-badge">${projectName}</span>
</div>
<div id="tabs">
  <div class="tab active" data-tab="chat">Chat</div>
  <div class="tab" data-tab="diff">Review</div>
  <div class="tab" data-tab="history">History</div>
</div>

<div id="tab-chat" class="visible">
  <div id="messages"></div>
  <div id="input-row">
    <textarea id="prompt-input" placeholder="Describe what you want to build or fix..." rows="1"></textarea>
    <button id="send-btn">Run</button>
  </div>
</div>

<div id="tab-diff">
  <div id="diff-header">
    <span class="commit-msg" id="commit-msg-text">No changes to review</span>
    <button class="btn-accept" id="btn-accept" style="display:none">Accept</button>
    <button class="btn-reject" id="btn-reject" style="display:none">Reject</button>
  </div>
  <div id="file-list"></div>
  <div id="diff-content"></div>
</div>

<div id="tab-history">
  <div id="history-list"><div style="padding:16px;opacity:.5;font-size:12px">Loading history...</div></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentJobId = null;

// ── Tab switching ──
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('[id^=tab-]').forEach(x => x.classList.remove('visible'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('visible');
    if (t.dataset.tab === 'history') vscode.postMessage({ type: 'loadHistory' });
  });
});

// ── Message helpers ──
const msgs = document.getElementById('messages');
function addMsg(role, text, cls='') {
  const d = document.createElement('div');
  d.className = 'msg ' + (cls || role);
  d.innerHTML = '<span class="role">' + role + '</span><span class="body">' + escHtml(text) + '</span>';
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function addDivider() {
  const d = document.createElement('hr'); d.className='divider'; msgs.appendChild(d);
}

// ── Send prompt ──
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});
sendBtn.addEventListener('click', send);

function send() {
  const text = input.value.trim();
  if (!text) return;
  addMsg('you', text, 'user');
  input.value = ''; input.style.height = 'auto';
  sendBtn.disabled = true;
  vscode.postMessage({ type: 'run', prompt: text });
}

// ── Accept / Reject ──
document.getElementById('btn-accept').addEventListener('click', () => {
  if (!currentJobId) return;
  vscode.postMessage({ type: 'accept', jobId: currentJobId });
  document.getElementById('btn-accept').style.display = 'none';
  document.getElementById('btn-reject').style.display = 'none';
  document.getElementById('commit-msg-text').textContent = '✔  Changes accepted';
});
document.getElementById('btn-reject').addEventListener('click', () => {
  if (!currentJobId) return;
  vscode.postMessage({ type: 'reject', jobId: currentJobId });
});

// ── Diff rendering ──
function renderDiff(data) {
  currentJobId = data.jobId;
  document.getElementById('commit-msg-text').textContent = data.commitMsg || 'Agent changes';
  document.getElementById('btn-accept').style.display = '';
  document.getElementById('btn-reject').style.display = '';

  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';
  (data.files || []).forEach(f => {
    const p = document.createElement('span');
    p.className = 'file-pill ' + (f.status || 'M');
    p.textContent = f.path.split(/[\\/]/).pop();
    p.title = f.path;
    fileList.appendChild(p);
  });

  const content = document.getElementById('diff-content');
  content.innerHTML = '';
  const rawDiff = data.diff || '';
  let currentFile = null, block = null;
  rawDiff.split('
').forEach(line => {
    if (line.startsWith('diff --git')) {
      if (block) content.appendChild(block);
      block = document.createElement('div'); block.className = 'diff-file-block';
      const header = document.createElement('div'); header.className = 'diff-file-name';
      const m = line.match(/b\/(.+)$/); header.textContent = m ? m[1] : line;
      block.appendChild(header); return;
    }
    if (!block) return;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) return;
    const l = document.createElement('div');
    l.className = 'diff-line' + (line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' meta' : '');
    l.textContent = line;
    block.appendChild(l);
  });
  if (block) content.appendChild(block);

  // Switch to diff tab
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('[id^=tab-]').forEach(x => x.classList.remove('visible'));
  document.querySelector('[data-tab=diff]').classList.add('active');
  document.getElementById('tab-diff').classList.add('visible');
}

// ── History rendering ──
function renderHistory(jobs) {
  const list = document.getElementById('history-list');
  if (!jobs || !jobs.length) {
    list.innerHTML = '<div style="padding:16px;opacity:.5;font-size:12px">No jobs yet</div>'; return;
  }
  list.innerHTML = '';
  jobs.slice(0, 50).forEach(j => {
    const row = document.createElement('div'); row.className = 'hist-row';
    const dot = document.createElement('div'); dot.className = 'hist-status ' + j.status;
    const info = document.createElement('div'); info.className = 'hist-info';
    const prompt = document.createElement('div'); prompt.className = 'hist-prompt';
    prompt.textContent = j.prompt || '(no prompt)';
    const meta = document.createElement('div'); meta.className = 'hist-meta';
    const dur = j.endedAt && j.startedAt ? ((j.endedAt - j.startedAt)/1000).toFixed(1) + 's · ' : '';
    meta.textContent = dur + j.status + ' · ' + (j.project || '') + ' · ' + new Date(j.createdAt).toLocaleTimeString();
    info.appendChild(prompt); info.appendChild(meta);
    row.appendChild(dot); row.appendChild(info);
    if (j.status === 'completed') {
      const btn = document.createElement('button'); btn.className = 'hist-diff-btn';
      btn.textContent = 'Review';
      btn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'showDiff', jobId: j.id }); });
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

// ── Messages from extension ──
window.addEventListener('message', e => {
  const m = e.data;
  if (!m) return;
  switch (m.type) {
    case 'step':        addMsg('agent', '[' + m.step + '] ' + (m.detail || ''), 'step'); break;
    case 'completed':   addMsg('agent', '✔  Done — ' + (m.result || ''), 'agent'); sendBtn.disabled = false; addDivider(); break;
    case 'failed':      addMsg('error', '✘  Failed: ' + (m.error || ''), 'error'); sendBtn.disabled = false; addDivider(); break;
    case 'reviewer':    addMsg('reviewer', '🔍 Reviewer: ' + m.text, 'reviewer'); break;
    case 'diff':        renderDiff(m.data); break;
    case 'history':     renderHistory(m.jobs); break;
    case 'revertDone':  document.getElementById('commit-msg-text').textContent = '↩  Changes reverted'; document.getElementById('btn-accept').style.display='none'; document.getElementById('btn-reject').style.display='none'; break;
    case 'revertFail':  addMsg('error', 'Revert failed: ' + m.error, 'error'); break;
  }
});
</script>
</body>
</html>`;
}

// ─── Open / reuse chat panel ──────────────────────────────────────────────────
function openPanel(context) {
    if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
    const ws = wsPath();
    panel = vscode.window.createWebviewPanel(
        "aidevmcp", "AI Dev MCP",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getPanelHtml(ws ? ws.split(/[\\/]/).pop() : "project");
    panel.onDidDispose(() => { panel = null; });

    panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {

            case "run": {
                if (!client) {
                    client = buildClient();
                    if (!client) {
                        vscode.window.showErrorMessage("AI Dev MCP: configure baseUrl and apiKey in Settings.");
                        return;
                    }
                }
                const wp = wsPath();
                if (!wp) { vscode.window.showErrorMessage("AI Dev MCP: open a workspace folder first."); return; }

                // Enrich with selected code from the active editor
                const enriched = enrichPrompt(msg.prompt);
                log(`Run: "${enriched.substring(0, 80)}..." on ${wp}`);

                try {
                    const job = await client.runTask(enriched, wp);
                    log(`Job: ${job.id}`);
                    await client.stream(job.id, m => {
                        if (m.event === "step") {
                            panel?.webview.postMessage({ type: "step", step: m.data?.step, detail: m.data?.detail });
                        } else if (m.event === "completed") {
                            panel?.webview.postMessage({ type: "completed", result: m.data?.result });
                            // Auto-load diff after completion
                            client.getDiff(job.id).then(d => {
                                panel?.webview.postMessage({ type: "diff", data: d });
                            }).catch(() => {});
                        } else if (m.event === "failed") {
                            panel?.webview.postMessage({ type: "failed", error: m.data?.error || JSON.stringify(m.data) });
                        }
                    });
                } catch (err) {
                    panel?.webview.postMessage({ type: "failed", error: err.message });
                    log(`Error: ${err.message}`);
                }
                break;
            }

            case "accept": {
                // Nothing to do server-side — changes are already committed
                log(`Accepted job ${msg.jobId}`);
                break;
            }

            case "reject": {
                // Show confirmation before reverting — this modifies git history
                const answer = await vscode.window.showWarningMessage(
                    "Reject and undo agent changes? This will create a revert commit.",
                    { modal: true },
                    "Revert (safe)", "Hard reset (destructive)"
                );
                if (!answer) return;
                try {
                    const hard = answer === "Hard reset (destructive)";
                    await client.revert(msg.jobId, hard);
                    panel?.webview.postMessage({ type: "revertDone" });
                    log(`Reverted job ${msg.jobId} (hard=${hard})`);
                } catch (err) {
                    panel?.webview.postMessage({ type: "revertFail", error: err.message });
                    log(`Revert failed: ${err.message}`);
                }
                break;
            }

            case "showDiff": {
                try {
                    const d = await client.getDiff(msg.jobId);
                    panel?.webview.postMessage({ type: "diff", data: d });
                } catch (err) {
                    log(`getDiff error: ${err.message}`);
                }
                break;
            }

            case "loadHistory": {
                try {
                    const jobs = await client.listJobs();
                    panel?.webview.postMessage({ type: "history", jobs });
                } catch (err) {
                    log(`listJobs error: ${err.message}`);
                }
                break;
            }
        }
    }, undefined, context.subscriptions);
}

// ─── activate ─────────────────────────────────────────────────────────────────
function activate(context) {
    out = vscode.window.createOutputChannel("AI Dev MCP");
    bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    bar.command = "aidevmcp.openChat";
    context.subscriptions.push(out, bar);

    client = buildClient();

    // Health check immediately + every 60s
    checkHealth();
    healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

    // Re-check when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("aidevmcp")) {
                client = buildClient();
                checkHealth();
            }
        })
    );

    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(

        vscode.commands.registerCommand("aidevmcp.openChat", () => {
            openPanel(context);
        }),

        // Quick run from command palette or right-click — shows input box
        vscode.commands.registerCommand("aidevmcp.runPrompt", async () => {
            const raw = await vscode.window.showInputBox({
                prompt: "AI Dev MCP — what do you want to do?",
                placeHolder: "e.g. Fix the login bug, Add a new API endpoint...",
                ignoreFocusOut: true,
            });
            if (!raw?.trim()) return;

            openPanel(context);
            // Small delay so the panel has time to mount its message listener
            await new Promise(r => setTimeout(r, 300));
            panel?.webview.postMessage({ type: "externalRun", prompt: raw.trim() });
            // Also trigger via the internal run path so the webview handles it
            panel?.webview.postMessage({ type: "injectPrompt", prompt: raw.trim() });

            // Run directly if panel not ready
            if (!client) { client = buildClient(); }
            if (!client) { vscode.window.showErrorMessage("Configure baseUrl and apiKey in Settings → AI Dev MCP"); return; }
            const wp = wsPath();
            if (!wp) { vscode.window.showErrorMessage("Open a workspace folder first."); return; }
            const enriched = enrichPrompt(raw.trim());
            log(`Quick run: "${enriched.substring(0, 80)}"`);
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "AI Dev MCP", cancellable: false },
                async progress => {
                    progress.report({ message: "Running agent..." });
                    try {
                        const job = await client.runTask(enriched, wp);
                        await client.waitForCompletion(job.id, m => {
                            if (m.event === "step") progress.report({ message: `[${m.data?.step}] ${m.data?.detail || ""}` });
                        });
                        vscode.window.showInformationMessage("AI Dev MCP: task completed.");
                    } catch (err) {
                        vscode.window.showErrorMessage(`AI Dev MCP failed: ${err.message}`);
                    }
                }
            );
        }),

        // Fix this — right-click shortcut
        vscode.commands.registerCommand("aidevmcp.fixThis", async () => {
            const ctx = getEditorCtx();
            if (!ctx?.selectedText) { vscode.window.showInformationMessage("Select code to fix first."); return; }
            const prompt = `Fix the following code:
\`\`\`${ctx.language}
${ctx.selectedText}
\`\`\``;
            openPanel(context);
            await new Promise(r => setTimeout(r, 300));
            panel?.webview.postMessage({ type: "injectPrompt", prompt });
        }),

        // Explain this — right-click shortcut
        vscode.commands.registerCommand("aidevmcp.explainThis", async () => {
            const ctx = getEditorCtx();
            if (!ctx?.selectedText) { vscode.window.showInformationMessage("Select code to explain first."); return; }
            const prompt = `Explain what this code does:
\`\`\`${ctx.language}
${ctx.selectedText}
\`\`\``;
            openPanel(context);
            await new Promise(r => setTimeout(r, 300));
            panel?.webview.postMessage({ type: "injectPrompt", prompt });
        }),

        // Add tests — right-click shortcut
        vscode.commands.registerCommand("aidevmcp.addTests", async () => {
            const ctx = getEditorCtx();
            const target = ctx?.selectedText || (ctx?.filePath ? `file: ${ctx.filePath}` : null);
            if (!target) { vscode.window.showInformationMessage("Open a file or select code first."); return; }
            const prompt = ctx.selectedText
                ? `Write unit tests for this code:
\`\`\`${ctx.language}
${ctx.selectedText}
\`\`\``
                : `Add unit tests for the file: ${ctx.filePath}`;
            openPanel(context);
            await new Promise(r => setTimeout(r, 300));
            panel?.webview.postMessage({ type: "injectPrompt", prompt });
        }),

        vscode.commands.registerCommand("aidevmcp.checkStatus", async () => {
            if (!client) { vscode.window.showErrorMessage("Not connected — configure settings first."); return; }
            try {
                const q = await client.getQueue();
                vscode.window.showInformationMessage(`MCP Queue: ${q.running ? "running" : "idle"} | pending: ${q.pending} | total: ${q.total}`);
            } catch (err) { vscode.window.showErrorMessage(`Queue check failed: ${err.message}`); }
        }),

        vscode.commands.registerCommand("aidevmcp.syncWorkspace", cmdSyncWorkspace));
    ctx.subscriptions.push(vscode.commands.registerCommand("aidevmcp.pullWorkspace",  cmdPullWorkspace));
    ctx.subscriptions.push(vscode.commands.registerCommand("aidevmcp.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp");
        }),

        vscode.commands.registerCommand("aidevmcp.listJobs", async () => {
            if (!client) { vscode.window.showErrorMessage("Not connected — configure settings first."); return; }
            try {
                const jobs = await client.listJobs();
                if (!jobs.length) { vscode.window.showInformationMessage("No jobs found."); return; }
                const items = jobs.slice(0, 20).map(j => ({
                    label:       `$(${j.status === "completed" ? "check" : j.status === "failed" ? "error" : "sync~spin"}) ${j.prompt?.substring(0, 60) || j.id}`,
                    description: `${j.status} · ${j.project}`,
                    detail:      new Date(j.createdAt).toLocaleString(),
                    jobId:       j.id,
                    status:      j.status
                }));
                const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a job to view" });
                if (picked && picked.status === "completed") {
                    openPanel(context);
                    await new Promise(r => setTimeout(r, 300));
                    panel?.webview.postMessage({ type: "showDiff", jobId: picked.jobId });
                }
            } catch (err) { vscode.window.showErrorMessage(`List jobs failed: ${err.message}`); }
        }),

        vscode.commands.registerCommand("aidevmcp.queueStatus", async () => {
            if (!client) { vscode.window.showErrorMessage("Not connected — configure settings first."); return; }
            try {
                const q = await client.getQueue();
                const msg = `Queue: ${q.running ? "▶ running" : "⏸ idle"} | pending: ${q.pending} | total jobs: ${q.total}`;
                vscode.window.showInformationMessage(msg);
            } catch (err) { vscode.window.showErrorMessage(`Queue status failed: ${err.message}`); }
        })
    );

    log("AI Dev MCP v1.3.0 activated");
}

function deactivate() {
    if (healthTimer) clearInterval(healthTimer);
}

module.exports = { activate, deactivate };
