import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class MCPClient {

    constructor() {
        const serverPath = path.resolve(__dirname, "../index.js");

        this.proc = spawn("node", [serverPath], {
            stdio: ["pipe", "pipe", "inherit"]
        });

        this.buffer = "";
        this.pending = new Map();

        this.proc.stdout.on("data", (data) => {
            this.handleData(data.toString());
        });

        this.proc.on("exit", (code) => {
            console.error(`[mcp] Server exited with code ${code}`);
            // Reject all pending calls
            for (const [id, { reject }] of this.pending) {
                reject(new Error("MCP server exited"));
                this.pending.delete(id);
            }
        });
    }

    handleData(chunk) {
        this.buffer += chunk;

        let boundary;
        while ((boundary = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, boundary).trim();
            this.buffer = this.buffer.slice(boundary + 1);

            if (!line) continue;

            try {
                const msg = JSON.parse(line);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(msg.error.message || "MCP tool error"));
                    } else {
                        resolve(msg.result);
                    }
                }
            } catch {
                // Ignore non-JSON lines (e.g. debug logs)
            }
        }
    }

    callTool(name, args = {}) {
        const id = `${Date.now()}-${Math.random()}`;

        const req = {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args }
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP timeout calling ${name}`));
            }, 60000);  // 60s timeout (was 20s — builds can be slow)

            this.pending.set(id, {
                resolve: (res) => { clearTimeout(timeout); resolve(res); },
                reject:  (err) => { clearTimeout(timeout); reject(err); }
            });

            this.proc.stdin.write(JSON.stringify(req) + "\n");
        });
    }
}