import path from "path";
import fs   from "fs";

export function validatePath(projectRoot, relativePath) {
    // Strip Next.js / Vite path aliases (e.g. @/components/Foo → components/Foo)
    relativePath = relativePath.replace(/^@\//, "").replace(/^~\//, "");
    // Block absolute paths, traversal, and null bytes
    if (
        path.isAbsolute(relativePath) ||
        relativePath.includes("..") ||
        relativePath.includes("\0")
    ) {
        throw new Error(`Invalid file path: ${relativePath}`);
    }

    const resolved     = path.resolve(projectRoot, relativePath);
    const resolvedRoot = path.resolve(projectRoot);

    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        throw new Error(`Path escapes project root: ${relativePath}`);
    }

    // Symlink traversal guard: resolve symlinks and re-check containment.
    // This prevents workspace → symlink → /etc/passwd style attacks.
    try {
        const realResolved = fs.realpathSync(resolved);
        const realRoot     = fs.realpathSync(resolvedRoot);
        if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
            throw new Error(`Symlink escapes project root: ${relativePath}`);
        }
    } catch (err) {
        // If the file doesn’t exist yet (new file being created), realpathSync throws.
        // ENOENT is acceptable — only re-throw symlink escape errors.
        if (err.code !== "ENOENT") throw err;
    }

    return resolved;
}

export function validateChangeRequest(files, projectRoot) {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error("files must be a non-empty array");
    }

    for (const file of files) {
        if (!file.path || typeof file.path !== "string") {
            throw new Error("Each file must have a path string");
        }
        if (typeof file.content !== "string") {
            throw new Error(`File ${file.path} must have string content`);
        }
        validatePath(projectRoot, file.path);
    }
}

/**
 * Safe commit message — strips shell-special characters.
 * Use this before passing a message to spawnSync.
 */
export function sanitizeCommitMessage(msg) {
    return String(msg)
        .replace(/[`$\\<>|;&]/g, "")
        .substring(0, 200)
        .trim() || "AI generated change";
}