import {getIndex, projectIndex} from "./projectIndex.js";

export async function projectFindSymbol({ project, name }) {
  let index = getIndex(project);
  if (!index) {
    await projectIndex({ project });
    index = getIndex(project);
  }

  // ADDED: guard against malformed index
  if (!index?.classes || !index?.functions) {
    return {
      content: [
        {
          type: "text",
          text: `Index could not be built for project "${project}". Try project_scan to find the file manually.`,
        },
      ],
    };
  }

  const query = name.toLowerCase();
  const matches = [
    ...index.classes
      .filter((c) => c.name.toLowerCase().includes(query))
      .map((m) => ({ type: "class", ...m })),
    ...index.functions
      .filter((f) => f.name.toLowerCase().includes(query))
      .map((m) => ({ type: "function", ...m })),
  ];

  return {
    content: [
      {
        type: "text",
        text:
          matches.length > 0
            ? JSON.stringify(matches, null, 2)
            : `No symbols found matching "${name}". Use project_scan to find the file path directly.`,
      },
    ],
  };
}
