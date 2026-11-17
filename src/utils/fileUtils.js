import fs from "fs";
import path from "path";

export function resolveSafePath(root, relative) {
    const resolvedRoot = path.resolve(root);
    const resolved     = path.resolve(root, relative);
    // Must start with root + separator to prevent partial-name traversal
    // e.g. root="/foo" would incorrectly allow "/foobar/secret" without the sep check
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        throw new Error("Unsafe path detected");
    }
    return resolved;
}

export function readFileLimited(filePath, maxSize) {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.length > maxSize) {
        return content.substring(0, maxSize) + "--- FILE TRUNCATED ---";
    }
    return content;
}