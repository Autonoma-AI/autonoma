import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ResolutionAgentLoop } from "../resolution-agent-loop";

export const generatedTestSchema = z.object({
    name: z.string().describe("Test name"),
    folderName: z.string().describe("Name of the folder to add the test to"),
    instruction: z.string().describe("Natural language test instruction"),
    url: z.string().optional().describe("URL to navigate to for the test"),
    reasoning: z.string().describe("Why this test was generated based on the diff"),
    scenarioId: z
        .string()
        .optional()
        .describe(
            "Id of the scenario whose seeded data this test depends on (obtained from `list_scenarios` / " +
                "`read_scenario`). Provide when the test needs preconditions like an authenticated user or " +
                "pre-existing records. Omit for tests that start from a fresh, unauthenticated state.",
        ),
    acceptingCandidateId: z
        .string()
        .optional()
        .describe(
            "Set this to the `candidate` id from the Test Candidates list when you are accepting one of those " +
                "candidates. Omit when you are creating a test that wasn't proposed in Step 1.",
        ),
});

export type GeneratedTest = z.infer<typeof generatedTestSchema>;

interface AddTestOutput {
    testName: string;
}

class UnknownFolderError extends FixableToolError {
    constructor(public readonly folderName: string) {
        super(`Folder "${folderName}" not found`);
    }

    override suggestFix(): string {
        return "Call `list_flows` to see the available folder names, then try again with one of those.";
    }
}

class UnknownScenarioError extends FixableToolError {
    constructor(public readonly scenarioId: string) {
        super(
            `Scenario "${scenarioId}" not found. Call \`list_scenarios\` to see available ` +
                `scenarios, or omit scenarioId if the test does not need seeded data.`,
        );
    }
}

/** Action tool: create a new test, possibly accepting a Step 1 candidate. */
export class AddTestTool extends AgentTool<GeneratedTest, AddTestOutput, ResolutionAgentLoop> {
    constructor() {
        super({
            name: "add_test",
            description:
                "Add a new test for functionality that has no test coverage. " +
                "Use this when the diff introduces new user-facing behavior that no existing test covers.",
            inputSchema: generatedTestSchema,
        });
    }

    protected async execute(input: GeneratedTest, loop: ResolutionAgentLoop): Promise<AddTestOutput> {
        if (loop.flowIndex.getFlow(input.folderName) === undefined) throw new UnknownFolderError(input.folderName);
        if (input.scenarioId != null && !loop.scenarioIndex.hasScenario(input.scenarioId)) {
            throw new UnknownScenarioError(input.scenarioId);
        }
        loop.newTests.push(input);
        return { testName: input.name };
    }
}
