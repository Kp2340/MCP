import path from "path";

export function validatePath(projectRoot, relativePath) {

    if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
        throw new Error("Invalid file path");
    }

    const resolved = path.resolve(projectRoot, relativePath);

    if (!resolved.startsWith(path.resolve(projectRoot))) {
        throw new Error("Path escapes project root");
    }

    return resolved;
}

export function validateChangeRequest(files, projectRoot) {

    for (const file of files) {

        if (!file.path || !file.content) {
            throw new Error("Invalid file structure");
        }

        validatePath(projectRoot, file.path);
    }
}