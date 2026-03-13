import { execFileSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";

export function searchProject({ project, query }) {
    const root = getProject(project).root;

    try {
        const result = execFileSync(
            "rg",
            [
                query,
                "-n",
                "--max-count", "20",
                "--max-columns", "200",
                "--no-heading",
                "--type", "js",          // Limit to code files — avoids binary/lock hits
                "--type", "ts",
                "--type", "java",
                "--glob", "!node_modules",
                "--glob", "!dist",
                "--glob", "!build",
                "--glob", "!.next"
            ],
            { cwd: root }
        ).toString();

        return {
            content: [{ type: "text", text: result.substring(0, 4000) }]
        };

    } catch {
        return {
            content: [{ type: "text", text: "No results found" }]
        };
    }
}
