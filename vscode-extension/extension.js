// AI Dev MCP — VS Code Extension v1.7.0
// v1.7.0: fix /run payload (path->project), SSE buffer split fix, refactorThis command, empty-key guard
// v1.6.0: cross-platform zip (Windows/macOS/Linux), improved chat webview
// v1.5.0: workspace sync

"use strict";
const vscode = require("vscode");
const cp     = require("child_process");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const DEFAULT_POLL_MS    = 2000;
const DEFAULT_TIMEOUT_MS = 300_000;
const HEALTH_INTERVAL_MS = 60_000;

// ─── MCPClient ────────────────────────────────────────────────────────────────
class MCPClient {
    constructor({ baseUrl, apiKey, timeout, pollInterval } = {}) {
        if (!baseUrl) throw new Error("MCPClient: baseUrl is required");
        if (!apiKey)  throw new Error("MCPClient: apiKey is required — set it in Settings > AI Dev MCP");
        this.baseUrl      = baseUrl.replace(/\/$/, "");
        this.apiKey       = apiKey;
        this.timeout      = timeout      ?? DEFAULT_TIMEOUT_MS;
        this.pollInterval = pollInterval ?? DEFAULT_POLL_MS;
    }

    _headers() {
        return { "Content-Type": "application/json", "x-api-key": this.apiKey };
    }

    async _json(urlPath, opts = {}) {
        const res = await fetch(`${this.baseUrl}${urlPath}`, {
            ...opts,
            headers: { ...this._headers(), ...(opts.headers || {}) },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`MCP ${opts.method || "GET"} ${urlPath} -> ${res.status}: ${body}`);
        }
        return res.json();
    }

    async health() { return this._json("/health"); }

    // FIX v1.7.0: server /run expects { project, prompt } not { path, prompt }
    // path was never a valid field — server uses project name from registry
    async runTask(prompt, project) {
        return this._json("/run", {
            method: "POST",
            body: JSON.stringify({ prompt, project }),
        });
    }

    async getStatus(id)  { return this._json(`/status/${id}`); }
    async getDiff(id)    { return this._json(`/diff/${id}`); }
    async listJobs(status) { return this._json(`/jobs${status ? `?status=${status}` : ""}`); }
    async getQueue()     { return this._json("/queue"); }

    async revert(id, hard = false) {
        return this._json(`/revert/${id}${hard ? "?hard=true" : ""}`, { method: "POST", body: "{}" });
    }

    // Workspace sync
    async pushWorkspace(projectName, zipBuffer) {
        const res = await fetch(`${this.baseUrl}/workspace/push?project=${encodeURIComponent(projectName)}`, {
            method:  "POST",
            headers: { "x-api-key": this.apiKey, "Content-Type": "application/octet-stream" },
            body:    zipBuffer,
        });
        if (!res.ok) throw new Error(`Push failed ${res.status}: ${await res.text().catch(() => "")}`);
        return res.json();
    }

    async pullWorkspace(projectName) {
        const res = await fetch(`${this.baseUrl}/workspace/pull/${encodeURIComponent(projectName)}`, {
            headers: { "x-api-key": this.apiKey },
        });
        if (!res.ok) throw new Error(`Pull failed ${res.status}: ${await res.text().catch(() => "")}`);
        return res.arrayBuffer();
    }

    async deleteWorkspace(projectName) {
        return this._json(`/workspace/${encodeURIComponent(projectName)}`, { method: "DELETE" });
    }

    // FIX v1.7.0: split on \n\n not on literal newlines which breaks on Windows
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
            // Split on double newline (\r\n\r\n or \n\n) — SSE event boundary
            const parts = buf.split(/\r?\n\r?\n/);
            buf = parts.pop(); // keep incomplete trailing chunk
            for (const block of parts) {
                let event = "message", data = null;
                for (const line of block.split(/\r?\n/)) {
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

// ─── Zip helpers (cross-platform) ─────────────────────────────────────────────
function zipFolder(srcDir, destZip) {
    return new Promise((resolve, reject) => {
        let proc;
        if (process.platform === "win32") {
            const src  = srcDir.replace(/'/g, "''");
            const dest = destZip.replace(/'/g, "''");
            proc = cp.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
                `Compress-Archive -Force -Path '${src}\\*' -DestinationPath '${dest}'`]);
        } else {
            proc = cp.spawn("zip", ["-r", "-q", destZip, "."], { cwd: srcDir });
        }
        let stderr = "";
        proc.stderr?.on("data", d => { stderr += d.toString(); });
        proc.on("close", code => code === 0 ? resolve() :
            reject(new Error(`zip failed (exit ${code})${stderr ? ": " + stderr.slice(0, 200) : ""}`)));
        proc.on("error", err =>
            reject(new Error(`zip not found: ${err.message} — on Linux: sudo apt install zip unzip`)));
    });
}

function unzipTo(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(destDir, { recursive: true });
        let proc;
        if (process.platform === "win32") {
            const src  = zipPath.replace(/'/g, "''");
            const dest = destDir.replace(/'/g, "''");
            proc = cp.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
                `Expand-Archive -Force -Path '${src}' -DestinationPath '${dest}'`]);
        } else {
            proc = cp.spawn("unzip", ["-o", "-q", zipPath, "-d", destDir]);
        }
        let stderr = "";
        proc.stderr?.on("data", d => { stderr += d.toString(); });
        proc.on("close", code => code === 0 ? resolve() :
            reject(new Error(`unzip failed (exit ${code})${stderr ? ": " + stderr.slice(0, 200) : ""}`)));
        proc.on("error", err =>
            reject(new Error(`unzip not found: ${err.message} — on Linux: sudo apt install zip unzip`)));
    });
}

// ─── Extension state ──────────────────────────────────────────────────────────
let out;          // OutputChannel
let bar;          // StatusBarItem
let panel = null; // WebviewPanel
let client = null;
let healthTimer = null;

function cfg()      { return vscode.workspace.getConfiguration("aidevmcp"); }
function log(msg)   { const t = new Date().toISOString().slice(0,19).replace("T"," "); out.appendLine(`[${t}] ${msg}`); }
function wsPath()   { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null; }
function projName() {
    const override = cfg().get("defaultProject");
    if (override && override.trim()) return override.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const p = wsPath();
    return p ? path.basename(p).toLowerCase().replace(/[^a-z0-9_-]/g, "-") : null;
}

// FIX v1.7.0: guard against empty API key before constructing client
function buildClient() {
    const baseUrl = cfg().get("baseUrl") || "";
    const apiKey  = cfg().get("apiKey")  || "";
    if (!baseUrl) {
        vscode.window.showErrorMessage("AI Dev MCP: Set Base URL in Settings (Ctrl+, -> search 'AI Dev MCP')");
        return null;
    }
    if (!apiKey) {
        vscode.window.showErrorMessage("AI Dev MCP: Set API Key in Settings (Ctrl+, -> search 'AI Dev MCP')");
        return null;
    }
    try { return new MCPClient({ baseUrl, apiKey }); }
    catch (e) { vscode.window.showErrorMessage(`AI Dev MCP: ${e.message}`); return null; }
}

// ─── Inline editor commands ───────────────────────────────────────────────────
function getSelectedCode(editor) {
    const sel = editor?.selection;
    if (!sel || sel.isEmpty) return "";
    return editor.document.getText(sel);
}

async function runInlineCommand(label, buildPrompt) {
    const editor  = vscode.window.activeTextEditor;
    const c       = buildClient();
    if (!c) return;
    const project = projName();
    if (!project) { vscode.window.showErrorMessage("Open a project folder first."); return; }

    const code     = getSelectedCode(editor);
    const filePath = editor?.document?.uri?.fsPath || "";
    const prompt   = buildPrompt(code, filePath, project);

    const job = await c.runTask(prompt, project).catch(e => {
        vscode.window.showErrorMessage(`MCP ${label} failed: ${e.message}`);
        return null;
    });
    if (!job) return;

    log(`${label} job: ${job.id}`);
    bar.text = `$(sync~spin) MCP: ${label}...`;
    streamAndNotify(c, job.id, label);
}

async function streamAndNotify(c, jobId, label) {
    try {
        await c.waitForCompletion(jobId, msg => {
            if (msg.event === "step") {
                bar.text = `$(sync~spin) MCP: ${String(msg.data?.detail || msg.data || "").slice(0,40)}`;
            }
        });
        bar.text = "$(check) MCP: Done";
        setTimeout(() => { bar.text = "$(robot) AI Dev MCP"; }, 4000);
        const answer = await vscode.window.showInformationMessage(`MCP: ${label} complete. Review changes?`, "Show diff", "Dismiss");
        if (answer === "Show diff") {
            const diff = await c.getDiff(jobId);
            showDiffPanel(diff);
        }
    } catch (e) {
        bar.text = "$(error) MCP: Failed";
        vscode.window.showErrorMessage(`MCP ${label} failed: ${e.message}`);
    }
}

function showDiffPanel(diff) {
    if (panel) panel.dispose();
    panel = vscode.window.createWebviewPanel("mcpDiff", `MCP Diff: ${diff.commitMsg || ""}`, vscode.ViewColumn.Beside, { enableScripts: true });
    const files = (diff.files || []).map(f =>
        `<span style="padding:2px 8px;border-radius:10px;margin-right:6px;font-size:11px;background:#1e1e1e;color:${
            f.status==="A"?"#4ec9b0":f.status==="D"?"#f48771":"#4fc1ff"}">${f.path.split(/[\\/]/).pop()}</span>`
    ).join("");
    const diffHtml = (diff.diff || "").split("\n").map(line => {
        const cls = line.startsWith("+")&&!line.startsWith("+++") ? "add"
                  : line.startsWith("-")&&!line.startsWith("---") ? "del"
                  : line.startsWith("@@") ? "meta" : "";
        const esc = line.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        return `<div class="${cls}">${esc}</div>`;
    }).join("");
    panel.webview.html = `<!DOCTYPE html><html><head><style>
        body{font-family:monospace;font-size:12px;background:#1e1e1e;color:#d4d4d4;padding:16px}
        .add{color:#4ec9b0;background:rgba(78,201,112,.08)}
        .del{color:#f48771;background:rgba(244,135,113,.08)}
        .meta{color:#555}
        .files{margin-bottom:12px}
        button{margin:4px;padding:6px 14px;border-radius:4px;border:none;cursor:pointer;font-size:12px}
        .accept{background:#16825d;color:#fff}
        .reject{background:#5a1d1d;color:#f48771}
    </style></head><body>
        <div class="files">${files}</div>
        <div style="margin-bottom:12px">
            <button class="accept" onclick="acquireVsCodeApi().postMessage({cmd:'accept'})">Accept changes</button>
            <button class="reject" onclick="acquireVsCodeApi().postMessage({cmd:'reject'})">Reject (revert)</button>
        </div>
        <pre style="white-space:pre-wrap;word-break:break-word">${diffHtml}</pre>
    </body></html>`;
    panel.webview.onDidReceiveMessage(async msg => {
        const c2 = buildClient();
        if (!c2) return;
        if (msg.cmd === "accept") {
            vscode.window.showInformationMessage("Changes accepted.");
            panel?.dispose();
        } else if (msg.cmd === "reject") {
            await c2.revert(diff.jobId).catch(e => vscode.window.showErrorMessage(`Revert failed: ${e.message}`));
            vscode.window.showInformationMessage("Changes reverted.");
            panel?.dispose();
        }
    });
}

// ─── Workspace sync commands ──────────────────────────────────────────────────
async function cmdSyncWorkspace() {
    const localDir = wsPath();
    if (!localDir) { vscode.window.showErrorMessage("Open a folder first."); return; }
    const c = buildClient();
    if (!c) return;
    const project = projName();

    const prompt = await vscode.window.showInputBox({
        prompt: `Prompt for the AI agent (project: ${project}) — leave empty to just sync files`,
        placeHolder: "e.g. Add a contact form to the homepage",
    });
    if (prompt === undefined) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `MCP Sync: ${project}`, cancellable: false,
    }, async progress => {
        const tmpZip = path.join(os.tmpdir(), `mcp-${project}-${Date.now()}.zip`);
        try {
            progress.report({ message: "Zipping workspace..." });
            await zipFolder(localDir, tmpZip);
            const zipBuffer = fs.readFileSync(tmpZip);
            log(`Pushing ${project} (${(zipBuffer.length/1024).toFixed(0)} KB)...`);

            progress.report({ message: "Uploading..." });
            const pushResult = await c.pushWorkspace(project, zipBuffer);
            log(`Push OK: ${pushResult.fileCount} files on server`);

            if (!prompt) {
                vscode.window.showInformationMessage(`Synced ${pushResult.fileCount} files as "${project}"`);
                return;
            }

            progress.report({ message: "Running AI agent..." });
            const job = await c.runTask(prompt, project);
            log(`Job started: ${job.id}`);
            progress.report({ message: `Job ${job.id} running...` });
            await c.waitForCompletion(job.id, msg => {
                if (msg.event === "step") progress.report({ message: String(msg.data?.detail || "").slice(0,80) });
            });

            progress.report({ message: "Pulling changes..." });
            const zipData  = await c.pullWorkspace(project);
            const pullZip  = path.join(os.tmpdir(), `mcp-${project}-pull-${Date.now()}.zip`);
            fs.writeFileSync(pullZip, Buffer.from(zipData));
            await unzipTo(pullZip, localDir);
            try { fs.unlinkSync(pullZip); } catch {}

            vscode.window.showInformationMessage(`MCP: Task complete. Changes pulled back to workspace.`);
        } catch (e) {
            vscode.window.showErrorMessage(`MCP Sync error: ${e.message}`);
            log(`Sync error: ${e.message}`);
        } finally {
            try { fs.unlinkSync(tmpZip); } catch {}
        }
    });
}

async function cmdPullWorkspace() {
    const localDir = wsPath();
    if (!localDir) { vscode.window.showErrorMessage("Open a folder first."); return; }
    const c = buildClient();
    if (!c) return;
    const project = projName();

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `MCP Pull: ${project}`, cancellable: false,
    }, async progress => {
        try {
            progress.report({ message: "Downloading changes from server..." });
            const zipData = await c.pullWorkspace(project);
            const pullZip = path.join(os.tmpdir(), `mcp-${project}-pull-${Date.now()}.zip`);
            fs.writeFileSync(pullZip, Buffer.from(zipData));
            await unzipTo(pullZip, localDir);
            try { fs.unlinkSync(pullZip); } catch {}
            vscode.window.showInformationMessage(`MCP: Changes pulled to workspace.`);
        } catch (e) {
            vscode.window.showErrorMessage(`MCP Pull error: ${e.message}`);
        }
    });
}

// ─── Main extension activation ────────────────────────────────────────────────
function activate(context) {
    out = vscode.window.createOutputChannel("AI Dev MCP");
    bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    bar.text    = "$(robot) AI Dev MCP";
    bar.tooltip = "AI Dev MCP — click to open chat";
    bar.command = "aidevmcp.openChat";
    bar.show();
    context.subscriptions.push(out, bar);

    // Health check loop
    function doHealth() {
        const c = buildClient();
        if (!c) return;
        c.health().then(h => {
            bar.text    = `$(robot) MCP v${h.version}`;
            bar.tooltip = `AI Dev MCP | projects: ${h.projects?.count ?? "?"} | queue: ${h.queue?.pending ?? 0} pending`;
        }).catch(() => {
            bar.text    = "$(warning) MCP: offline";
            bar.tooltip = "AI Dev MCP: cannot reach server";
        });
    }
    doHealth();
    healthTimer = setInterval(doHealth, HEALTH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand("aidevmcp.openSettings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp")),

        vscode.commands.registerCommand("aidevmcp.runPrompt", async () => {
            const c = buildClient();
            if (!c) return;
            const project = projName();
            if (!project) { vscode.window.showErrorMessage("Open a project folder first."); return; }
            const editor = vscode.window.activeTextEditor;
            const selectedCode = getSelectedCode(editor);
            const filePath = editor?.document?.uri?.fsPath || "";

            const prompt = await vscode.window.showInputBox({
                prompt: "What should the agent do?",
                placeHolder: "e.g. Fix the login bug, Add a new API endpoint...",
            });
            if (!prompt) return;

            const fullPrompt = selectedCode
                ? `${prompt}\n\nFile: ${filePath}\n\nSelected code:\n${selectedCode}`
                : prompt;

            bar.text = "$(sync~spin) MCP: Starting...";
            const job = await c.runTask(fullPrompt, project).catch(e => {
                vscode.window.showErrorMessage(`MCP error: ${e.message}`);
                bar.text = "$(robot) AI Dev MCP";
                return null;
            });
            if (!job) return;
            log(`Job submitted: ${job.id}`);
            streamAndNotify(c, job.id, "task");
        }),

        vscode.commands.registerCommand("aidevmcp.fixThis", () =>
            runInlineCommand("Fix", (code, file, proj) =>
                `Fix the following code in project: ${proj}\nFile: ${file}\n\n${code}`)),

        vscode.commands.registerCommand("aidevmcp.explainThis", () =>
            runInlineCommand("Explain", (code, file, proj) =>
                `Explain the following code in project: ${proj}\nFile: ${file}\n\n${code}`)),

        vscode.commands.registerCommand("aidevmcp.refactorThis", () =>
            runInlineCommand("Refactor", (code, file, proj) =>
                `Refactor the following code to improve readability and maintainability in project: ${proj}\nFile: ${file}\n\n${code}`)),

        vscode.commands.registerCommand("aidevmcp.addTests", () =>
            runInlineCommand("Add Tests", (code, file, proj) =>
                `Write unit tests for the following code in project: ${proj}\nFile: ${file}\n\n${code}`)),

        vscode.commands.registerCommand("aidevmcp.listJobs", async () => {
            const c = buildClient();
            if (!c) return;
            const jobs = await c.listJobs().catch(e => { vscode.window.showErrorMessage(e.message); return []; });
            const items = jobs.map(j => ({
                label:       `$(${j.status==="completed"?"check":j.status==="failed"?"error":"sync~spin"}) ${j.id}`,
                description: j.status,
                detail:      j.prompt?.slice(0,80) || "",
                jobId:       j.id,
            }));
            const picked = await vscode.window.showQuickPick(items, { title: "MCP Jobs", placeHolder: "Select a job to view diff" });
            if (picked) {
                const diff = await c.getDiff(picked.jobId).catch(() => null);
                if (diff) showDiffPanel(diff);
            }
        }),

        vscode.commands.registerCommand("aidevmcp.checkStatus", async () => {
            const c = buildClient();
            if (!c) return;
            const id = await vscode.window.showInputBox({ prompt: "Job ID" });
            if (!id) return;
            const job = await c.getStatus(id).catch(e => { vscode.window.showErrorMessage(e.message); return null; });
            if (job) vscode.window.showInformationMessage(`Job ${id}: ${job.status}${job.error ? " — " + job.error : ""}`);
        }),

        vscode.commands.registerCommand("aidevmcp.queueStatus", async () => {
            const c = buildClient();
            if (!c) return;
            const q = await c.getQueue().catch(e => { vscode.window.showErrorMessage(e.message); return null; });
            if (q) vscode.window.showInformationMessage(`Queue: running=${q.running}, pending=${q.pending}, total=${q.total}`);
        }),

        vscode.commands.registerCommand("aidevmcp.openChat", () => {
            vscode.commands.executeCommand("aidevmcp.runPrompt");
        }),

        vscode.commands.registerCommand("aidevmcp.syncWorkspace", cmdSyncWorkspace),
        vscode.commands.registerCommand("aidevmcp.pullWorkspace", cmdPullWorkspace),
    );

    log("AI Dev MCP v1.7.0 activated");
}

function deactivate() {
    clearInterval(healthTimer);
    panel?.dispose();
}

module.exports = { activate, deactivate };
