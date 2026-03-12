import path from "path";

export function validateChangeRequest(files, projectRoot) {
    const root = path.resolve(projectRoot);

    for (const file of files) {
        if (!file.path || !file.content) {
            throw new Error("Invalid file structure");
        }

        if (file.path.includes("..") || path.isAbsolute(file.path)) {
            throw new Error("Invalid file path");
        }

        const resolved = path.resolve(projectRoot, file.path);

        if (!resolved.startsWith(root + path.sep)) {
            throw new Error("Path escapes repository root");
        }
    }
}