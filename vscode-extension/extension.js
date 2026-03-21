// AI Dev MCP — VS Code Extension v1.1.0
// Calls POST /run (agentic mode — Qwen2.5 agent loop)
// Never connects to /sse — that is for Antigravity / Claude Desktop only.

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

    // MCP-3.11: sends "path" so the server can auto-register unknown projects
    async runTask(prompt, project, projectPath) {
        const body = { prompt, project };
        if (projectPath) body.path = projectPath;
        const data = await this._json("/run", {
            method: "POST",
            body:   JSON.stringify(body),
        });
        return data.id;
    }

    async getStatus(jobId) {
        return this._json(`/status/${jobId}`);
    }

    async listJobs(statusFilter) {
        const qs = statusFilter ? `?status=${statusFilter}` : "";
        return this._json(`/jobs${qs}`);
    }

    async getQueue() {
        return this._json("/queue");
    }

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
            const tid = setTimeout(
                () => reject(new Error(`Timed out after ${this.timeout}ms`)),
                this.timeout
            );
            try {
                await this.stream(jobId, (msg) => {
                    if (onProgress) onProgress(msg);
                    if (msg.event === "completed") { clearTimeout(tid); resolve(msg.data); }
                    if (msg.event === "failed")    { clearTimeout(tid); reject(new Error(JSON.stringify(msg.data))); }
                });
                clearTimeout(tid);
            } catch {
                clearTimeout(tid);
                // Fallback: poll
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
let client = null;

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

// ── Project helpers ───────────────────────────────────────────────────────────

/** Returns the workspace root filesystem path (e.g. C:/Projects/zeveal-backend). */
function getWorkspacePath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;  // absolute path, e.g. C:\Projects\zeveal-backend
}

/**
 * Returns the project name to use:
 *   1. User-configured defaultProject override
 *   2. Workspace folder base name (lowercased)
 */
function getWorkspaceProjectName() {
    const override = getConfig().get("defaultProject");
    if (override) return override;
    const wsPath = getWorkspacePath();
    if (!wsPath) return null;
    // e.g. "C:/Users/kush/zeveal-backend" -> "zeveal-backend"
    return wsPath.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
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

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdRunPrompt() {
    client = buildClient();
    if (!client) {
        const action = await vscode.window.showErrorMessage(
            "AI Dev MCP: baseUrl or apiKey not configured.",
            "Open Settings"
        );
        if (action === "Open Settings") {
            vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp");
        }
        return;
    }

    // 1. Project — auto-detected from workspace, user can override
    const autoName    = getWorkspaceProjectName();
    const wsPath      = getWorkspacePath();
    const projectName = await vscode.window.showInputBox({
        prompt:      "Project name (auto-detected — press Enter to confirm or type another)",
        placeHolder: autoName ?? "my-project",
        value:       autoName ?? "",
    });
    if (!projectName) return;

    // 2. Prompt — pre-fill with selected code context
    const ctx    = getEditorContext();
    const prefix = ctx?.selectedText
        ? `[File: ${ctx.filePath}, line ${ctx.lineNumber}]\n\`\`\`\n${ctx.selectedText}\n\`\`\`\n\n`
        : "";

    const prompt = await vscode.window.showInputBox({
        prompt:      "What should the AI do?",
        placeHolder: "Fix the login bug / Analyse the project / Add unit tests",
        value:       prefix,
    });
    if (!prompt) return;

    // 3. Show output panel
    outputChannel.show(true);
    log(`\u25b6  Running: "${prompt.slice(0, 80)}${prompt.length > 80 ? "\u2026" : ""}" on [${projectName}]`);
    if (wsPath) log(`   Path: ${wsPath}`);
    setStatus("$(sync~spin) MCP Running\u2026", "AI Dev MCP \u2014 job running", new vscode.ThemeColor("statusBarItem.warningBackground"));

    try {
        // 4. Submit — pass workspace path so server auto-registers if needed
        const jobId = await client.runTask(prompt, projectName, wsPath);
        log(`   Job ID: ${jobId}`);
        log(`   Stream: ${getConfig().get("baseUrl")}/stream/${jobId}`);
        log("\u2500".repeat(60));

        // 5. Stream live progress
        let stepCount = 0;
        const jobResult = await client.waitForCompletion(jobId, (msg) => {
            const d = msg.data;
            if (!d) return;

            if (msg.event === "poll") {
                log(`   \u21bb status: ${d.status}`);
                return;
            }
            // MCP-3.11: step event from queue.emitJobStep()
            if (msg.event === "step") {
                stepCount++;
                log(`   [${d.step ?? stepCount}] ${d.detail ?? JSON.stringify(d)}`);
                return;
            }
            if (msg.event === "queued") {
                log(`   Queued at position ${d.position ?? "?"}`);
                return;
            }
            if (msg.event === "started") {
                log(`   Agent started`);
                return;
            }

            stepCount++;
            if (typeof d === "string") {
                log(`   ${d}`);
            } else if (d.log) {
                log(`   [${d.step ?? stepCount}] ${d.log}`);
            } else if (d.result) {
                log(`   result: ${d.result}`);
            } else if (d.status) {
                log(`   status \u2192 ${d.status}`);
            } else {
                log(`   ${JSON.stringify(d)}`);
            }
        });

        // 6. Done
        log("\u2500".repeat(60));
        log(`\u2714  Completed. ${typeof jobResult === "object" ? JSON.stringify(jobResult, null, 2) : jobResult}`);
        setStatus("$(check) MCP Done", "AI Dev MCP \u2014 last job completed");

        vscode.window.showInformationMessage(
            `AI Dev MCP: Task completed for [${projectName}]`,
            "View Logs"
        ).then(a => { if (a === "View Logs") outputChannel.show(); });

    } catch (err) {
        log(`\u2718  Error: ${err.message}`);
        setStatus("$(error) MCP Failed", "AI Dev MCP \u2014 last job failed", new vscode.ThemeColor("statusBarItem.errorBackground"));
        vscode.window.showErrorMessage(
            `AI Dev MCP: ${err.message}`,
            "View Logs"
        ).then(a => { if (a === "View Logs") outputChannel.show(); });
    }
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
    } catch (err) {
        vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`);
    }
}

async function cmdListJobs() {
    client = buildClient();
    if (!client) return;
    try {
        const jobs = await client.listJobs();
        outputChannel.show(true);
        log("\u2500".repeat(60));
        log(`All jobs (${jobs.length}):`);
        for (const j of jobs) {
            log(`  ${j.id} | ${j.status.padEnd(10)} | ${j.project ?? ""} | ${(j.prompt ?? "").slice(0, 60)}`);
        }
        log("\u2500".repeat(60));
    } catch (err) {
        vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`);
    }
}

async function cmdQueueStatus() {
    client = buildClient();
    if (!client) return;
    try {
        const q = await client.getQueue();
        outputChannel.show(true);
        log(`Queue: running=${q.running} | pending=${q.pending} | total=${q.total}`);
        if (q.currentJobId) log(`  Current job: ${q.currentJobId}`);
    } catch (err) {
        vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`);
    }
}

async function cmdOpenSettings() {
    vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp");
}

// ── Activate / Deactivate ─────────────────────────────────────────────────────

function activate(context) {
    outputChannel = vscode.window.createOutputChannel("AI Dev MCP");
    outputChannel.appendLine("AI Dev MCP v1.1.0 activated. Uses POST /run (agentic mode).");

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = "aidevmcp.runPrompt";
    setStatus("$(robot) MCP", "AI Dev MCP \u2014 click to run a task");

    const cmds = [
        vscode.commands.registerCommand("aidevmcp.runPrompt",    cmdRunPrompt),
        vscode.commands.registerCommand("aidevmcp.checkStatus",  cmdCheckStatus),
        vscode.commands.registerCommand("aidevmcp.listJobs",     cmdListJobs),
        vscode.commands.registerCommand("aidevmcp.queueStatus",  cmdQueueStatus),
        vscode.commands.registerCommand("aidevmcp.openSettings", cmdOpenSettings),
    ];
    context.subscriptions.push(...cmds, statusBar);
}

function deactivate() {}

module.exports = { activate, deactivate };
