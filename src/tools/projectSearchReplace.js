import fs from "fs";
import { getProject } from "../core/projectRegistry.js";
import { validatePath } from "../core/validator.js";

export function projectSearchReplace({ project, edits }) {

    const root = getProject(project).root;

    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must be non-empty array");
    }

    let changed = 0;

    for (const e of edits) {

        const full = validatePath(root, e.path);

        if (!fs.existsSync(full)) {
            throw new Error(`File not found: ${e.path}`);
        }

        let content = fs.readFileSync(full, "utf8");

        if (!content.includes(e.search)) {
            throw new Error(`Search string not found in ${e.path}`);
        }

        content = content.replace(e.search, e.replace);

        fs.writeFileSync(full, content, "utf8");

        changed++;
    }

    return {
        content: [
            {
                type: "text",
                text: `Applied ${changed} search/replace edits`
            }
        ]
    };
}