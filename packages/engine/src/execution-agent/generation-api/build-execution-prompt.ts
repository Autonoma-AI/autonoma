export function buildExecutionPrompt(
    basePrompt: string,
    customInstructions?: string | null,
    credentials?: Record<string, string>,
    recipeVariables?: Record<string, string>,
): string {
    const parts: string[] = [];

    if (credentials != null && Object.keys(credentials).length > 0) {
        const credentialLines = Object.entries(credentials)
            .map(([key]) => `- ${key}: {{${key}}}`)
            .join("\n");

        parts.push(
            `Before starting the test, log in using the following credentials. When typing each value, use the variable reference shown - do not type the variable name literally, the system resolves it to the actual value at runtime:\n${credentialLines}`,
        );
    }

    if (recipeVariables != null && Object.keys(recipeVariables).length > 0) {
        const variableLines = Object.entries(recipeVariables)
            .map(([key, _]) => `- ${key} (reference as {{${key}}})`)
            .join("\n");

        parts.push(
            `The test environment was set up with the following dynamic data. These values change between runs. When you encounter them in the UI or need to type/assert them, always use the variable reference (e.g. {{variableName}}) instead of the literal value:\n${variableLines}`,
        );
    }

    parts.push(basePrompt.trimEnd());

    const normalizedInstructions = customInstructions?.trim();
    if (normalizedInstructions != null && normalizedInstructions.length > 0) {
        parts.push(`## Application-specific instructions

These instructions come from the application settings and apply to every run unless the test plan explicitly says otherwise.

${normalizedInstructions}`);
    }

    return parts.join("\n\n");
}
