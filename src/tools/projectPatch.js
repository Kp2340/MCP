import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";

export function applyPatch({ project, patch }) {

    const root = getProject(project).root;

    if (patch.includes("../")) {
        throw new Error("Unsafe patch path");
    }

    const patchPath = path.join(root, "ai.patch");

    fs.writeFileSync(patchPath, patch);

    execSync(`git apply ${patchPath}`, { cwd: root });

    fs.unlinkSync(patchPath);

    return {
        content: [{ type: "text", text: "Patch applied" }]
    };
}