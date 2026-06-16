import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { HealingAgentLoop } from "../healing-agent-loop";

export const healingNewTestSchema = z.object({
    name: z.string().describe("Test name"),
    folderName: z.string().describe("Name of the folder (flow) to add the test to"),
    instruction: z.string().describe("Natural language test instruction"),
    url: z.string().optional().describe("URL to navigate to for the test"),
    reasoning: z.string().describe("Why this test should exist given the code change"),
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
                "candidates. Omit only when you are creating a test that was not proposed as a candidate.",
        ),
});

export type HealingNewTest = z.infer<typeof healingNewTestSchema>;

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

class UnknownCandidateError extends FixableToolError {
    constructor(public readonly candidateId: string) {
        super(
            `acceptingCandidateId "${candidateId}" does not match any candidate in the Test Candidates list. ` +
                `Use the exact \`candidate\` id, or omit acceptingCandidateId to create a test that was not proposed.`,
        );
    }
}

class ClaimedCandidateError extends FixableToolError {
    constructor(public readonly candidateId: string) {
        super(
            `Candidate "${candidateId}" has already been accepted by an earlier add_test call this turn. ` +
                `Each candidate can be accepted at most once.`,
        );
    }
}

class SpontaneousAddNotAllowedError extends FixableToolError {
    constructor() {
        super(
            "Spontaneous add_test (without acceptingCandidateId) is only allowed on the first turn of the " +
                "refinement loop. On later turns you may only accept a candidate from the Test Candidates list.",
        );
    }
}

/**
 * Action tool: create a new test, optionally accepting a candidate.
 *
 * Two guards enforced at the boundary:
 *  - (a) `acceptingCandidateId` must reference a live, not-yet-claimed candidate.
 *  - (b) a spontaneous add (no `acceptingCandidateId`) is allowed only on the
 *    first turn; later turns may only graduate candidates.
 */
export class HealingAddTestTool extends AgentTool<HealingNewTest, AddTestOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "add_test",
            description:
                "Add a new test for functionality that has no test coverage. Accept a proposed candidate by " +
                "passing its id as `acceptingCandidateId`, or (first turn only) propose one of your own. Use this " +
                "when the change introduces new user-facing behavior no existing test covers.",
            inputSchema: healingNewTestSchema,
        });
    }

    protected async execute(input: HealingNewTest, loop: HealingAgentLoop): Promise<AddTestOutput> {
        if (loop.flowIndex.getFlow(input.folderName) === undefined) throw new UnknownFolderError(input.folderName);
        if (input.scenarioId != null && !loop.scenarioIndex.hasScenario(input.scenarioId)) {
            throw new UnknownScenarioError(input.scenarioId);
        }

        if (input.acceptingCandidateId != null) {
            this.claimCandidate(input.acceptingCandidateId, loop);
        } else if (!loop.isFirstTurn) {
            throw new SpontaneousAddNotAllowedError();
        }

        loop.newTests.push(input);
        return { testName: input.name };
    }

    /** Guard (a): the candidate must exist and not already be claimed; claim it on success. */
    private claimCandidate(candidateId: string, loop: HealingAgentLoop): void {
        if (!loop.candidatesById.has(candidateId)) throw new UnknownCandidateError(candidateId);
        if (loop.claimedCandidateIds.has(candidateId)) throw new ClaimedCandidateError(candidateId);
        loop.claimedCandidateIds.add(candidateId);
    }
}
