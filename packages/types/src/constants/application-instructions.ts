/**
 * The cap on each of an application's two free-text instruction fields
 * (`customInstructions`, `testScopeGuidelines`).
 *
 * Shared so the settings textarea, the tRPC input schema and the MCP tool agree. They did not
 * before: the UI stopped at 2000 while the API accepted 5000, so an agent could write instructions
 * a human then could not re-save from the settings page without deleting someone else's words.
 */
export const APPLICATION_INSTRUCTIONS_MAX_LENGTH = 5000;
