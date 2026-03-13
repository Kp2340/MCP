import fs from "fs";
import path from "path";

export function resolveSafePath(root, relative) {
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(path.resolve(root))) {
        throw new Error("Unsafe path detected");
    }
    return resolved;
}

export function readFileLimited(filePath, maxSize) {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.length > maxSize) {
        return content.substring(0, maxSize) + "\n\n--- FILE TRUNCATED ---";
    }
    return content;
}
