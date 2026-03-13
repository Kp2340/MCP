import { getIndex } from "./projectIndex.js";

export function projectFindSymbol({ project, name }) {

    const index = getIndex(project);

    if (!index) {
        throw new Error("Project index not built");
    }

    const matches = [];

    index.classes.forEach(c => {
        if (c.name.includes(name)) matches.push(c);
    });

    index.functions.forEach(f => {
        if (f.name.includes(name)) matches.push(f);
    });

    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(matches, null, 2)
            }
        ]
    };
}