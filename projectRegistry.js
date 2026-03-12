import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, "projects.json");

if (!fs.existsSync(filePath)) {
    throw new Error("projects.json not found at: " + filePath);
}

const projects = JSON.parse(fs.readFileSync(filePath, "utf-8"));

export function getProject(name) {
    if (!projects[name]) {
        throw new Error("Project not found: " + name);
    }
    return projects[name];
}