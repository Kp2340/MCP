import { project_search } from "../tools/projectSearch.js";

export async function retrieve(project, query) {
  try {
    // try semantic first (if available)
    let results = [];
    try {
      results = await project_search(project, query);
    } catch {
      results = [];
    }

    if (!results || results.length === 0) {
      // fallback keyword search
      console.warn("[retriever] fallback to keyword search");
      results = await project_search(project, query);
    }

    return results.map(r => r.content || r).slice(0, 10);
  } catch (e) {
    console.warn("[retriever-error]", e.message);
    return [];
  }
}