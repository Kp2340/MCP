import fs from "fs";
import path from "path";
import { IGNORE_FOLDERS, INDEX_CACHE_FILE } from "../core/constants.js";

const VALID_EXTENSIONS = [
  ".java", ".js", ".jsx", ".ts", ".tsx",
  ".json", ".xml", ".yml", ".yaml"
];

function isValidFile(filePath) {
  return VALID_EXTENSIONS.some(ext => filePath.endsWith(ext));
}

export function buildSemanticIndex(projectRoot) {
  const index = { classes: [], functions: [] };

  function scanFile(fullPath, relPath) {
    let source;
    try {
      source = fs.readFileSync(fullPath, "utf8");
    } catch {
      return;
    }

    const lines = source.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes("class ")) {
        index.classes.push({ name: line.trim(), file: relPath, line: i + 1 });
      }
      if (line.includes("function ") || line.includes("=>")) {
        index.functions.push({ name: line.trim(), file: relPath, line: i + 1 });
      }
    });
  }

  function walk(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const full = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (IGNORE_FOLDERS.includes(item.name)) continue;
        walk(full);
      } else {
        if (!isValidFile(full)) continue;
        const relPath = path.relative(projectRoot, full);
        scanFile(full, relPath);
      }
    }
  }

  walk(projectRoot);

  const cachePath = path.join(projectRoot, INDEX_CACHE_FILE);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(index), "utf8");
  } catch {}

  return index;
}
