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
                "--max-count",
                "20",
                "--max-columns",
                "200",
                "--no-heading"
            ],
            { cwd: root }
        ).toString();

        return {
            content: [
                {
                    type: "text",
                    text: result.substring(0, 4000)
                }
            ]
        };

    } catch {

        return {
            content: [
                {
                    type: "text",
                    text: "No results found"
                }
            ]
        };

    }
}