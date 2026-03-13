import fs from "fs";
import path from "path";

const logDir = "logs";

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

export function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(logDir, "agent.log"), line);
}

export function logTool(tool, args) {
    const line = `[${new Date().toISOString()}] TOOL ${tool} ${JSON.stringify(args)}\n`;
    fs.appendFileSync(path.join(logDir, "tools.log"), line);
}