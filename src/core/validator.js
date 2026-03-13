import path from "path";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 20000;

const BLOCKED_EXTENSIONS = [
    ".env",
    ".xml",
    ".properties",
    ".config",
    ".yaml",
    ".yml"
];

export function validatePath(projectRoot, relativePath) {

    if (
        path.isAbsolute(relativePath) ||
        relativePath.includes("..") ||
        relativePath.includes("\0")
    ) {
        throw new Error(`Invalid path: ${relativePath}`);
    }

    const resolved = path.resolve(projectRoot, relativePath);
    const root = path.resolve(projectRoot);

    if (!resolved.startsWith(root)) {
        throw new Error(`Path escapes project root: ${relativePath}`);
    }

    const ext = path.extname(relativePath);

    if (BLOCKED_EXTENSIONS.includes(ext)) {
        throw new Error(`Access to config file blocked: ${relativePath}`);
    }

    return resolved;
}

export function validateChangeRequest(files) {

    if (!Array.isArray(files) || files.length === 0) {
        throw new Error("files must be non-empty array");
    }

    if (files.length > MAX_FILES) {
        throw new Error(`Max ${MAX_FILES} files allowed`);
    }

    for (const file of files) {

        if (!file.path || typeof file.path !== "string") {
            throw new Error("File must include path");
        }

        if (typeof file.content !== "string") {
            throw new Error(`File ${file.path} must include content`);
        }

        if (file.content.length > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${file.path}`);
        }

        const ext = path.extname(file.path);

        if (BLOCKED_EXTENSIONS.includes(ext)) {
            throw new Error(`Editing config files not allowed: ${file.path}`);
        }
    }
}

export function sanitizeCommitMessage(msg) {

    return String(msg)
        .replace(/[`$\\<>|;&]/g, "")
        .substring(0, 200)
        .trim() || "AI generated change";
}