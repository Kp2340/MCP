export function parseErrors(buildOutput) {

    const errors = [];

    const lines = buildOutput.split("\n");

    for (const line of lines) {

        if (
            line.includes("error") ||
            line.includes("Exception") ||
            line.includes("Failed")
        ) {
            errors.push(line);
        }
    }

    return errors.slice(0, 10);
}