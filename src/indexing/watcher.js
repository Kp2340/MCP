import chokidar from "chokidar";
import fs from "fs";
import path from "path";
import { smartIndex } from "./incrementalIndex.js";
import { getProject } from "../core/projectRegistry.js";

export function startWatcher(projectName) {
  const project = getProject(projectName);
  const root = project.root;

  let timer;

  const watcher = chokidar.watch(root, {
    ignored: /node_modules|\.git|data|\.jsonl|\.log|\.ai-dev-index-cache\.json|\.idea/,
    persistent: true
  });

  watcher.on("change", (filePath) => {
    clearTimeout(timer);

    timer = setTimeout(async () => {
      try {
        const rel = path.relative(root, filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        await smartIndex(projectName, rel, content);
      } catch (e) {}
    }, 300);
  });

  return watcher;
}