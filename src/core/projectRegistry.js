import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectsPath = path.join(__dirname, "../config/projects.json");

const projects = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));

export function getProject(name) {

    if (!projects[name]) {
        throw new Error("Project not found: " + name);
    }

    return projects[name];
}