import fs from "fs";
import path from "path";
import { getProject } from "../core/projectRegistry.js";

function walk(dir, results = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      walk(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

export function searchProject({ project, query }) {
  const root = getProject(project).root;
  const files = walk(root);
  const results = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      if (content.includes(query)) {
        results.push({ file, snippet: content.substring(0, 200) });
      }
    } catch {}
  }

  return {
    content: [{ type: "text", text: JSON.stringify(results.slice(0, 50), null, 2) }]
  };
}
