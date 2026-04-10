import fs from "fs";
import path from "path";

const CACHE_FILE = path.resolve(".embed-cache.json");

let cache = {};

try {
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  }
} catch (e) {
  cache = {};
}

function save() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {}
}

export function getPersistentEmbedding(key) {
  return cache[key];
}

export function setPersistentEmbedding(key, value) {
  cache[key] = value;
  save();
}
