// AI Dev MCP — VS Code Extension
// Connects to your MCP server and lets you run AI coding tasks from inside VS Code.

const vscode = require("vscode");

// ── Inline MCPClient (no external deps, no build step) ───────────────────────
// Copied from src/client/mcpClient.js so the extension is self-contained.

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS       = 300_000;

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
            throw new Error(`MCP ${opts.method || "GET"} ${path} → ${res.status}: ${body}`);
        }
        return res.json();
    }

    async runTask(prompt, project) {
        const data = await this._json("/run", {
            method: "POST",
            body:   JSON.stringify({ prompt, project }),
        });
        return data.id;
    }

    async getStatus(jobId) {
        return this._json(`/status/${jobId}`);
    }

    async stream(jobId, onMessage) {
        const res = await fetch(`${this.baseUrl}/stream/${jobId}`, {
            headers: { ...this._headers(), Accept: "text/event-stream" },
        });
        if (!res.ok) throw new Error(`Stream ${res.status}`);

        const reader = res.body.getReader();
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
                    try { onMessage({ event, data: JSON.parse(data) }); } catch {
                        onMessage({ event, data });
                    }
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

/** @type {vscode.OutputChannel} */
let outputChannel;
/** @type {vscode.StatusBarItem} */
let statusBar;
/** @type {MCPClient|null} */
let client = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConfig() {
    return vscode.workspace.getConfiguration("aidevmcp");
}

function buildClient() {
    const cfg    = getConfig();
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

// ── Active project helpers ────────────────────────────────────────────────────

function getWorkspaceProject() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    // Use the configured override if set
    const override = getConfig().get("defaultProject");
    if (override) return override;
    // Fall back to folder name (lower-cased, hyphens stripped)
    return folders[0].name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const doc  = editor.document;
    const sel  = editor.selection;
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

    // 1. Pick project
    const autoProject = getWorkspaceProject();
    const project = await vscode.window.showInputBox({
        prompt:      "Project key (must match projects.json on the server)",
        placeHolder: autoProject ?? "jsv",
        value:       autoProject ?? "",
    });
    if (!project) return;

    // 2. Get prompt — pre-fill with selected code context
    const ctx    = getEditorContext();
    const prefix = ctx?.selectedText
        ? `[File: ${ctx.filePath}, line ${ctx.lineNumber}]\n\`\`\`\n${ctx.selectedText}\n\`\`\`\n\n`
        : "";

    const prompt = await vscode.window.showInputBox({
        prompt:      "What should the AI do?",
        placeHolder: "Fix the login bug / Add unit tests / Refactor this function",
        value:       prefix,
    });
    if (!prompt) return;

    // 3. Show output panel
    outputChannel.show(true);
    log(`▶  Running: "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}" on project [${project}]`);
    setStatus("$(sync~spin) MCP Running…", "AI Dev MCP — job running", new vscode.ThemeColor("statusBarItem.warningBackground"));

    try {
        // 4. Submit
        const jobId = await client.runTask(prompt, project);
        log(`   Job ID: ${jobId}`);
        log(`   Stream: ${getConfig().get("baseUrl")}/stream/${jobId}`);
        log("─".repeat(60));

        // 5. Stream logs
        let stepCount = 0;
        const jobResult = await client.waitForCompletion(jobId, (msg) => {
            const d = msg.data;
            if (!d) return;

            if (msg.event === "poll") {
                log(`   ↻ status: ${d.status}`);
                return;
            }

            stepCount++;
            if (typeof d === "string") {
                log(`   ${d}`);
            } else if (d.log) {
                log(`   [${d.step ?? stepCount}] ${d.log}`);
            } else if (d.status) {
                log(`   status → ${d.status}`);
            } else {
                log(`   ${JSON.stringify(d)}`);
            }
        });

        // 6. Done
        log("─".repeat(60));
        log(`✔  Completed. Result: ${typeof jobResult === "object" ? JSON.stringify(jobResult, null, 2) : jobResult}`);
        setStatus("$(check) MCP Done", "AI Dev MCP — last job completed");

        vscode.window.showInformationMessage(
            `AI Dev MCP: Task completed for [${project}]`,
            "View Logs"
        ).then(a => { if (a === "View Logs") outputChannel.show(); });

    } catch (err) {
        log(`✘  Error: ${err.message}`);
        setStatus("$(error) MCP Failed", "AI Dev MCP — last job failed", new vscode.ThemeColor("statusBarItem.errorBackground"));

        vscode.window.showErrorMessage(
            `AI Dev MCP: ${err.message}`,
            "View Logs"
        ).then(a => { if (a === "View Logs") outputChannel.show(); });
    }
}

async function cmdCheckStatus() {
    client = buildClient();
    if (!client) {
        vscode.window.showErrorMessage("AI Dev MCP: not configured. Check settings.");
        return;
    }

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
        log("─".repeat(60));
        log(`All jobs (${jobs.length}):`);
        for (const j of jobs) {
            log(`  ${j.id} | ${j.status.padEnd(10)} | ${j.project ?? ""} | ${j.prompt?.slice(0, 60) ?? ""}`);
        }
        log("─".repeat(60));
    } catch (err) {
        vscode.window.showErrorMessage(`AI Dev MCP: ${err.message}`);
    }
}

async function cmdOpenSettings() {
    vscode.commands.executeCommand("workbench.action.openSettings", "aidevmcp");
}

// ── Activate / Deactivate ─────────────────────────────────────────────────────

function activate(context) {
    // Output channel
    outputChannel = vscode.window.createOutputChannel("AI Dev MCP");
    outputChannel.appendLine("AI Dev MCP extension activated.");

    // Status bar
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = "aidevmcp.runPrompt";
    setStatus("$(robot) MCP", "AI Dev MCP — click to run a task");

    // Register commands
    const commands = [
        vscode.commands.registerCommand("aidevmcp.runPrompt",   cmdRunPrompt),
        vscode.commands.registerCommand("aidevmcp.checkStatus", cmdCheckStatus),
        vscode.commands.registerCommand("aidevmcp.listJobs",    cmdListJobs),
        vscode.commands.registerCommand("aidevmcp.openSettings",cmdOpenSettings),
    ];

    context.subscriptions.push(outputChannel, statusBar, ...commands);

    // Eagerly validate config
    client = buildClient();
    if (!client) {
        vscode.window.showWarningMessage(
            "AI Dev MCP: Set baseUrl and apiKey in settings to get started.",
            "Open Settings"
        ).then(a => { if (a === "Open Settings") cmdOpenSettings(); });
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
