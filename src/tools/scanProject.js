import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";

function walk(dir, root, results = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      results.push({ type: "directory", path: path.relative(root, fullPath) });
      walk(fullPath, root, results);
    } else {
      results.push({ type: "file", path: path.relative(root, fullPath) });
    }
  }

  return results;
}

export function scanProject({ project }) {
  const projectRoot = getProject(project).root;

  try {
    const files = walk(projectRoot, projectRoot);
    return {
      content: [{ type: "text", text: JSON.stringify({ totalItems: files.length, items: files }, null, 2) }]
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error scanning project: ${err.message}` }]
    };
  }
}
