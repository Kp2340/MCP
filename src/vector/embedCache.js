const cache = new Map();

export function getCachedEmbedding(key) {
  return cache.get(key);
}

export function setCachedEmbedding(key, value) {
  cache.set(key, value);
}
