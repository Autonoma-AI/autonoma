/**
 * The input that an execution agent will receive to generate a test case.
 */
export interface TestCase {
    /** The name of the test case */
    name: string;
    /** The natural language prompt describing what to do */
    prompt: string;
    /** The preparation scripts to run before the execution of the test case */
    preparation?: string;
    /** Credentials from the scenario up call, pre-seeded into the agent's memory as {{key}} variables */
    credentials?: Record<string, string>;
    /** Recipe variables resolved during scenario up, pre-seeded into the agent's memory as {{key}} variables */
    recipeVariables?: Record<string, string>;
}
