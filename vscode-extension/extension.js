// AI Dev MCP — VS Code Extension v1.2.0
// Features: Chat panel webview, live step streaming, diff review, accept/reject changes

const vscode = require("vscode");

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS       = 300_000;

// ── MCPClient ─────────────────────────────────────────────────────────────────
class MCPClient {
    constructor({ baseUrl, apiKey, timeout, pollInterval } = {}) {
        if (!baseUrl) throw new Error("MCPClient: baseUrl is required");
        if (!apiKey)  throw new Error("MCPClient: apiKey is required");
        this.baseUrl      = baseUrl.replace(/\/$/, "");
        this.apiKey       = apiKey;
        this.timeout      = timeout      ?? DEFAULT_TIMEOUT_MS;
        this.pollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
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
            throw new Error(`MCP ${opts.method || "GET"} ${path} \u2192 ${res.status}: ${body}`);
        }
        return res.json();
    }

    // Security: only send prompt + path. Server derives project name from path.
    async runTask(prompt, projectPath) {
        const body = { prompt, path: projectPath };
        return this._json("/run", { method: "POST", body: JSON.stringify(body) });
    }

    async getStatus(jobId)  { return this._json(`/status/${jobId}`); }
    async getDiff(jobId)    { return this._json(`/diff/${jobId}`); }
    async revert(jobId)     { return this._json(`/revert/${jobId}`, { method: "POST", body: "{}" }); }
    async listJobs(filter)  { return this._json(`/jobs${filter ? `?status=${filter}` : ""}`); }
    async getQueue()        { return this._json("/queue"); }

    async stream(jobId, onMessage) {
        const res = await fetch(`${this.baseUrl}/stream/${jobId}`, {
            headers: { ...this._headers(), Accept: "text/event-stream" },
        });
        if (!res.ok) throw new Error(`Stream ${res.status}`);
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop();
            for (const block of parts) {
                let event = "message", data = null;
                for (const line of block.split("\n")) {
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
                await this.stream(jobId, (msg) => {
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
                        if (job.status === "completed") return resolve(job);
                        if (job.status === "failed")    return reject(new Error(job.error));
                        await new Promise(r => setTimeout(r, this.pollInterval));
                    }
                    reject(new Error("Polling timed out"));
                } catch (e) { reject(e); }
            }
        });
    }
}

// ── Extension state ───────────────────────────────────────────────────────────
let outputChannel;
let statusBar;
let chatPanel = null;   // The active WebviewPanel (chat + diff review)
let client    = null;

function getConfig() {
    return vscode.workspace.getConfiguration("aidevmcp");
}

function buildClient() {
    const cfg     = getConfig();
    const baseUrl = cfg.get("baseUrl") || process.env.MCP_BASE_URL || "";
    const apiKey  = cfg.get("apiKey")  || process.env.MCP_API_KEY  || "";
    if (!baseUrl || !apiKey) return null;
    return new MCPClient({ baseUrl, apiKey });
}

function setStatus(text, tooltip, color) {
    statusBar.text    = text;
    statusBar.tooltip = tooltip ?? "AI Dev MCP";
    statusBar.color   = color   ?? new vscode.ThemeColor("statusBar.foreground");
    statusBar.show();
}

function log(msg) {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

function getWorkspacePath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
}

function getEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const doc = editor.document;
    const sel = editor.selection;
    return {
        filePath:     doc.uri.fsPath,
        language:     doc.languageId,
        selectedText: sel.isEmpty ? null : doc.getText(sel),
        lineNumber:   sel.active.line + 1,
    };
}

// ── Chat Panel (Webview) ──────────────────────────────────────────────────────

function getChatPanelHtml(wsPath) {
    const projectName = wsPath ? wsPath.split(/[\\/]/).pop() : "project";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px;
         background: var(--vscode-editor-background);
         color: var(--vscode-foreground); display: flex; flex-direction: column;
         height: 100vh; overflow: hidden; }

  /* ── Header ── */
  #header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border);
             display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  #header .title { font-weight: 600; font-size: 13px; flex: 1; }
  #header .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px;
                   background: var(--vscode-badge-background);
                   color: var(--vscode-badge-foreground); }

  /* ── Tabs ── */
  #tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  .tab { padding: 7px 16px; cursor: pointer; font-size: 12px; opacity: 0.65;
          border-bottom: 2px solid transparent; user-select: none; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
  .tab:hover { opacity: 1; }

  /* ── Tab panels ── */
  #tab-chat, #tab-diff { flex: 1; overflow: hidden; display: none; flex-direction: column; }
  #tab-chat.visible, #tab-diff.visible { display: flex; }

  /* ── Chat messages ── */
  #messages { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex;
               flex-direction: column; gap: 10px; }
  .msg { display: flex; flex-direction: column; gap: 3px; }
  .msg .role { font-size: 11px; font-weight: 600; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.5px; }
  .msg.user .role  { color: var(--vscode-textLink-foreground); }
  .msg.agent .role { color: #4ec9b0; }
  .msg.step .role  { color: #dcdcaa; }
  .msg.error .role { color: var(--vscode-errorForeground); }
  .msg .body { line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.step .body  { opacity: 0.75; font-size: 12px; }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
  .spinner { display: inline-block; width: 10px; height: 10px; border: 1.5px solid currentColor;
              border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite;
              margin-right: 6px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Prompt input ── */
  #input-row { padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border);
                display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0; }
  #prompt-input { flex: 1; background: var(--vscode-input-background);
                   color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
                   border-radius: 4px; padding: 7px 10px; font-family: inherit; font-size: 13px;
                   resize: none; min-height: 36px; max-height: 120px; outline: none; }
  #prompt-input:focus { border-color: var(--vscode-focusBorder); }
  #send-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
               border: none; border-radius: 4px; padding: 7px 14px; cursor: pointer;
               font-size: 12px; font-family: inherit; white-space: nowrap; }
  #send-btn:hover { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Diff panel ── */
  #diff-header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border);
                  display: flex; align-items: center; gap: 10px; flex-shrink: 0; flex-wrap: wrap; }
  #diff-header .commit-msg { font-size: 12px; flex: 1; opacity: 0.85; font-style: italic;
                              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-accept { background: #16825d; color: #fff; border: none; border-radius: 4px;
                 padding: 5px 14px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .btn-accept:hover { background: #1a9e6e; }
  .btn-reject { background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
                 color: var(--vscode-errorForeground, #f48771);
                 border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
                 border-radius: 4px; padding: 5px 14px; cursor: pointer;
                 font-size: 12px; font-family: inherit; }
  .btn-reject:hover { opacity: 0.85; }
  #file-list { padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border);
                display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
  .file-pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; cursor: pointer; }
  .file-pill.M { background: #1f3a5f; color: #4fc1ff; }
  .file-pill.A { background: #163a1e; color: #4ec9b0; }
  .file-pill.D { background: #3a1616; color: #f48771; }
  #diff-content { flex: 1; overflow-y: auto; padding: 0; }
  .diff-file-block { margin: 0; }
  .diff-file-name { padding: 6px 14px; font-size: 11px; font-weight: 600;
                     background: var(--vscode-editorGroupHeader-tabsBackground);
                     border-bottom: 1px solid var(--vscode-panel-border);
                     color: var(--vscode-tab-activeForeground); }
  .diff-line { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
                padding: 1px 14px; white-space: pre; display: block; }
  .diff-line.add  { background: rgba(70,160,70,0.18); color: #4ec9b0; }
  .diff-line.del  { background: rgba(200,60,60,0.18);  color: #f48771; }
  .diff-line.meta { opacity: 0.45; }
  #diff-empty { padding: 24px; opacity: 0.5; text-align: center; font-size: 12px; }
  #diff-loading { padding: 24px; text-align: center; font-size: 12px; opacity: 0.6; }
</style>
</head>
<body>
<div id="header">
  <span class="title">&#129302; AI Dev MCP</span>
  <span class="badge" id="project-badge">${escapeHtml(projectName)}</span>
</div>
<div id="tabs">
  <div class="tab active" data-tab="chat" onclick="switchTab('chat')">Chat</div>
  <div class="tab" data-tab="diff" onclick="switchTab('diff')">Changes <span id="diff-badge" style="display:none;font-size:10px;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);margin-left:4px">0</span></div>
</div>

<!-- Chat tab -->
<div id="tab-chat" class="visible">
  <div id="messages"></div>
  <div id="input-row">
    <textarea id="prompt-input" placeholder="Ask the AI to fix a bug, add a feature, explain code…" rows="1"></textarea>
    <button id="send-btn" onclick="sendPrompt()">Send</button>
  </div>
</div>

<!-- Diff/Review tab -->
<div id="tab-diff">
  <div id="diff-header">
    <span class="commit-msg" id="commit-msg-text">No changes yet</span>
    <button class="btn-accept" id="btn-accept" onclick="acceptChanges()" style="display:none">&#10003; Accept</button>
    <button class="btn-reject" id="btn-reject" onclick="rejectChanges()" style="display:none">&times; Reject</button>
  </div>
  <div id="file-list"></div>
  <div id="diff-content"><div id="diff-empty">Run a task to see file changes here.</div></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentJobId = null;
let running = false;

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('tab-chat').classList.toggle('visible', name === 'chat');
  document.getElementById('tab-diff').classList.toggle('visible', name === 'diff');
}

function addMsg(role, text, type) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg ' + (type || role);
  const labels = { user: 'You', agent: 'Agent', step: 'Step', error: 'Error', system: 'System' };
  div.innerHTML = '<span class="role">' + escHtml(labels[type || role] || role) + '</span>' +
                  '<span class="body">' + escHtml(text) + '</span>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function addDivider() {
  const msgs = document.getElementById('messages');
  const hr   = document.createElement('hr');
  hr.className = 'divider';
  msgs.appendChild(hr);
}

function setRunning(val) {
  running = val;
  const btn   = document.getElementById('send-btn');
  const input = document.getElementById('prompt-input');
  btn.disabled   = val;
  input.disabled = val;
  btn.textContent = val ? '\u23F3 Running\u2026' : 'Send';
}

function sendPrompt() {
  if (running) return;
  const input  = document.getElementById('prompt-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = '';
  input.style.height = 'auto';
  vscode.postMessage({ command: 'run', prompt });
}

// Auto-resize textarea
document.getElementById('prompt-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
// Ctrl+Enter or Cmd+Enter to send
document.getElementById('prompt-input').addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendPrompt(); }
});

function acceptChanges() {
  if (!currentJobId) return;
  document.getElementById('btn-accept').disabled = true;
  document.getElementById('btn-reject').disabled = true;
  document.getElementById('commit-msg-text').textContent = '\u2714 Changes accepted';
  addMsg('system', 'Changes accepted \u2014 commit kept.', 'system');
  vscode.postMessage({ command: 'accept', jobId: currentJobId });
  currentJobId = null;
}

function rejectChanges() {
  if (!currentJobId) return;
  document.getElementById('btn-accept').disabled = true;
  document.getElementById('btn-reject').disabled = true;
  document.getElementById('commit-msg-text').textContent = '\u23F3 Reverting\u2026';
  vscode.postMessage({ command: 'reject', jobId: currentJobId });
}

function renderDiff(data) {
  currentJobId = data.jobId;

  // Update commit message
  document.getElementById('commit-msg-text').textContent = data.commitMsg || 'Changes ready for review';
  document.getElementById('btn-accept').style.display = 'inline-block';
  document.getElementById('btn-reject').style.display = 'inline-block';
  document.getElementById('btn-accept').disabled = false;
  document.getElementById('btn-reject').disabled = false;

  // File pills
  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';
  (data.files || []).forEach(f => {
    const pill = document.createElement('span');
    pill.className = 'file-pill ' + (f.status || 'M');
    const icon = f.status === 'A' ? '+ ' : f.status === 'D' ? '- ' : '~ ';
    pill.textContent = icon + f.path;
    pill.title = { M: 'Modified', A: 'Added', D: 'Deleted' }[f.status] || f.status;
    fileList.appendChild(pill);
  });

  // Update diff badge
  const badge = document.getElementById('diff-badge');
  badge.textContent = (data.files || []).length;
  badge.style.display = 'inline';

  // Render diff lines
  const content = document.getElementById('diff-content');
  content.innerHTML = '';
  if (!data.diff) {
    content.innerHTML = '<div id="diff-empty">No diff available.</div>';
    return;
  }

  let currentBlock = null;
  data.diff.split('\n').forEach(line => {
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('diff --git')) {
        const block = document.createElement('div');
        block.className = 'diff-file-block';
        const name = document.createElement('div');
        name.className = 'diff-file-name';
        name.textContent = line.replace('diff --git a/', '').split(' b/')[0];
        block.appendChild(name);
        content.appendChild(block);
        currentBlock = block;
      }
      return;
    }
    if (!currentBlock) return;
    const span = document.createElement('span');
    span.className = 'diff-line' +
      (line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' :
       line.startsWith('@@') ? ' meta' : '');
    span.textContent = line;
    currentBlock.appendChild(span);
  });
}

// Messages from the extension host
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'running':
      setRunning(true);
      addMsg('user', msg.prompt, 'user');
      addDivider();
      break;
    case 'step':
      addMsg('step', '[' + msg.step + '] ' + msg.detail, 'step');
      break;
    case 'queued':  addMsg('system', 'Queued at position ' + msg.position, 'system'); break;
    case 'started': addMsg('system', 'Agent started \u2026', 'system'); break;
    case 'completed':
      setRunning(false);
      addDivider();
      addMsg('agent', '\u2714 Task completed. Loading diff\u2026', 'agent');
      document.getElementById('diff-content').innerHTML = '<div id="diff-loading">Loading changes\u2026</div>';
      break;
    case 'diff':
      // Update the last agent message
      const agentMsgs = document.querySelectorAll('.msg.agent .body');
      if (agentMsgs.length) agentMsgs[agentMsgs.length - 1].textContent = '\u2714 Task completed \u2014 ' + (msg.data.files || []).length + ' file(s) changed. Review in the Changes tab.';
      renderDiff(msg.data);
      break;
    case 'reverted':
      document.getElementById('commit-msg-text').textContent = '\u2718 Changes rejected \u2014 reverted';
      addMsg('system', 'Changes rejected and reverted.', 'error');
      document.getElementById('diff-content').innerHTML = '<div id="diff-empty">Changes reverted.</div>';
      document.getElementById('file-list').innerHTML = '';
      document.getElementById('diff-badge').style.display = 'none';
      currentJobId = null;
      break;
    case 'error':
      setRunning(false);
      addDivider();
      addMsg('error', '\u2718 ' + msg.message, 'error');
      break;
    case 'no-diff':
      addMsg('agent', '\u2714 Task completed. No file changes were committed.', 'agent');
      setRunning(false);
      break;
    case '_switchTab':
      switchTab(msg.tab);
      break;
    case '_prefill':
      const inp = document.getElementById('prompt-input');
      inp.value = msg.text;
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
      inp.focus();
      break;
  }
});
</script>
</body>
</html>`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function ensureChatPanel(context) {
    if (chatPanel) {
        chatPanel.reveal(vscode.ViewColumn.Beside);
        return chatPanel;
    }
    chatPanel = vscode.window.createWebviewPanel(
        "aidevmcpChat",
        "AI Dev MCP",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const wsPath = getWorkspacePath();
    chatPanel.webview.html = getChatPanelHtml(wsPath || "");

    // Handle messages from the webview
    chatPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === "run") {
            await cmdRunFromPanel(msg.prompt, chatPanel);
        }
        if (msg.command === "accept") {
            log(`Accepted changes for job ${msg.jobId}`);
            // Nothing to do server-side — the commit is already kept
        }
        if (msg.command === "reject") {
            await rejectFromPanel(msg.jobId, chatPanel);
        }
    });

    chatPanel.onDidDispose(() => { chatPanel = null; });
    return chatPanel;
}

async function cmdRunFromPanel(prompt, panel) {
    client = buildClient();
    if (!client) {
        panel.webview.postMessage({ type: "error", message: "Not configured. Open Settings and set baseUrl + apiKey." });
        return;
    }
    const wsPath = getWorkspacePath();
    if (!wsPath) {
        panel.webview.postMessage({ type: "error", message: "Open a workspace folder first." });
        return;
    }

    // Inject editor context if text is selected
    const ctx = getEditorContext();
    const fullPrompt = ctx?.selectedText
        ? `[File: ${ctx.filePath}, line ${ctx.lineNumber}]\n\`\`\`\n${ctx.selectedText}\n\`\`\`\n\n${prompt}`
        : prompt;

    panel.webview.postMessage({ type: "running", prompt });
    setStatus("$(sync~spin) MCP Running\u2026", "AI Dev MCP — job running", new vscode.ThemeColor("statusBarItem.warningBackground"));
    log(`\u25b6 Running: "${prompt.slice(0, 80)}" | path: ${wsPath}`);

    try {
        const jobData = await client.runTask(fullPrompt, wsPath);
        const jobId   = jobData.id;
        log(`   Job: ${jobId}`);

        let stepCount = 0;
        await client.waitForCompletion(jobId, (msg) => {
            const d = msg.data;
            if (!d) return;
            if (msg.event === "step") {
                stepCount++;
                panel.webview.postMessage({ type: "step", step: d.step ?? stepCount, detail: d.detail ?? JSON.stringify(d) });
            } else if (msg.event === "queued") {
                panel.webview.postMessage({ type: "queued", position: d.position ?? 0 });
            } else if (msg.event === "started") {
                panel.webview.postMessage({ type: "started" });
            }
        });

        panel.webview.postMessage({ type: "completed", jobId });
        setStatus("$(check) MCP Done", "AI Dev MCP — job completed");
        log(`\u2714 Completed: ${jobId}`);

        // Switch to diff tab and load changes
        setTimeout(async () => {
            try {
                const diff = await client.getDiff(jobId);
                if (diff && diff.files && diff.files.length > 0) {
                    panel.webview.postMessage({ type: "diff", data: diff });
                    // Auto-switch to Changes tab
                    panel.webview.postMessage({ type: "_switchTab", tab: "diff" });
                } else {
                    panel.webview.postMessage({ type: "no-diff" });
                }
            } catch (e) {
                panel.webview.postMessage({ type: "no-diff" });
            }
        }, 800);

    } catch (err) {
        log(`\u2718 Error: ${err.message}`);
        setStatus("$(error) MCP Failed", "AI Dev MCP — job failed", new vscode.ThemeColor("statusBarItem.errorBackground"));
        panel.webview.postMessage({ type: "error", message: err.message });
    }
}

async function rejectFromPanel(jobId, panel) {
    client = buildClient();
    if (!client) return;
    try {
        await client.revert(jobId);
        panel.webview.postMessage({ type: "reverted" });
        log(`Reverted job ${jobId}`);
    } catch (err) {
        panel.webview.postMessage({ type: "error", message: `Revert failed: ${err.message}` });
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdOpenChat(context) {
    const panel = ensureChatPanel(context);
    // If there's selected text, pre-fill the prompt area
    const ctx = getEditorContext();
    if (ctx?.selectedText) {
        panel.webview.postMessage({
            type: "_prefill",
            text: `[File: ${ctx.filePath}, line ${ctx.lineNumber}]\n\`\`\`\n${ctx.selectedText}\n\`\`\`\n\n`
        });
    }
}

async function cmdRunPrompt(context) {
    // Quick input box flow (legacy) — opens panel and sends directly
    client = buildClient();
    if (!client) {
        const action = await vscode.window.showErrorMessage("AI Dev MCP: baseUrl or apiKey not configured.", "Open Settings");
        if (action === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp");
        return;
    }
    const wsPath = getWorkspacePath();
    if (!wsPath) { vscode.window.showErrorMessage("AI Dev MCP: Open a workspace folder first."); return; }

    const ctx    = getEditorContext();
    const prefix = ctx?.selectedText
        ? `[File: ${ctx.filePath}, line ${ctx.lineNumber}]\n\`\`\`\n${ctx.selectedText}\n\`\`\`\n\n`
        : "";
    const prompt = await vscode.window.showInputBox({
        prompt: "What should the AI do?",
        placeHolder: "Fix the login bug / Add unit tests / Explain this code",
        value: prefix,
    });
    if (!prompt) return;

    const panel = ensureChatPanel(context);
    await cmdRunFromPanel(prompt, panel);
}

async function cmdCheckStatus() {
    client = buildClient();
    if (!client) { vscode.window.showErrorMessage("AI Dev MCP: not configured."); return; }
    const jobId = await vscode.window.showInputBox({ prompt: "Enter Job ID to check" });
    if (!jobId) return;
    try {
        const job = await client.getStatus(jobId);
        outputChannel.show(true);
        log(`Status for ${jobId}:`);
        log(JSON.stringify(job, null, 2));
    } catch (err) { vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`); }
}

async function cmdListJobs() {
    client = buildClient();
    if (!client) return;
    try {
        const jobs = await client.listJobs();
        outputChannel.show(true);
        log("─".repeat(60));
        log(`All jobs (${jobs.length}):`);
        for (const j of jobs)
            log(`  ${j.id} | ${j.status.padEnd(10)} | ${j.project ?? ""} | ${(j.prompt ?? "").slice(0, 60)}`);
        log("─".repeat(60));
    } catch (err) { vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`); }
}

async function cmdQueueStatus() {
    client = buildClient();
    if (!client) return;
    try {
        const q = await client.getQueue();
        outputChannel.show(true);
        log(`Queue: running=${q.running} pending=${q.pending} total=${q.total}`);
    } catch (err) { vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`); }
}

// ── Activate ──────────────────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel("AI Dev MCP");
    statusBar     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = "aidevmcp.openChat";
    setStatus("$(robot) AI Dev MCP", "AI Dev MCP — click to open chat");

    context.subscriptions.push(
        vscode.commands.registerCommand("aidevmcp.openChat",    () => cmdOpenChat(context)),
        vscode.commands.registerCommand("aidevmcp.runPrompt",   () => cmdRunPrompt(context)),
        vscode.commands.registerCommand("aidevmcp.checkStatus", cmdCheckStatus),
        vscode.commands.registerCommand("aidevmcp.listJobs",    cmdListJobs),
        vscode.commands.registerCommand("aidevmcp.queueStatus", cmdQueueStatus),
        vscode.commands.registerCommand("aidevmcp.openSettings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp")
        ),
        outputChannel,
        statusBar
    );
}

function deactivate() {
    if (chatPanel) { chatPanel.dispose(); chatPanel = null; }
}

module.exports = { activate, deactivate };
