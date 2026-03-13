import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectsPath = path.join(__dirname, "../config/projects.json");

function loadProjects() {
    return JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
}

export function getProject(name) {
    // Hot-reload: re-read on every call so adding a project doesn't need restart
    const projects = loadProjects();
    if (!projects[name]) {
        throw new Error(
            `Project not found: "${name}". Available: ${Object.keys(projects).join(", ")}`
        );
    }
    return projects[name];
}

export function listProjects() {
    return Object.keys(loadProjects());
}
