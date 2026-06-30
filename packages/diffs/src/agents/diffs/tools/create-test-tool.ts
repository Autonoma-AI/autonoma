import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentLoop } from "../diffs-agent-loop";

/**
 * Minimum length (after trimming) for a created test's `description`.
 *
 * The runner persists `description` as the test case's immutable
 * `TestCase.description`, and downstream consumers (e.g. `scenario_unsupported`)
 * anchor on it as the test's durable, loop-stable intent. A blank or one-word
 * placeholder is worse than no description at all for those consumers, so the
 * schema requires a real, falsifiable behavioral claim here.
 */
export const MIN_DESCRIPTION_LENGTH = 20;

export const createTestSchema = z.object({
    name: z.string().describe("Test name"),
    folderName: z.string().describe("Name of the folder (flow) to add the test to"),
    description: z
        .string()
        .min(MIN_DESCRIPTION_LENGTH)
        .refine((value) => value.trim().length >= MIN_DESCRIPTION_LENGTH, {
            message:
                `Description must be a specific, falsifiable behavioral claim of at least ` +
                `${MIN_DESCRIPTION_LENGTH} characters - describe the behavior being tested, not a placeholder.`,
        })
        .describe(
            "The test's durable intent, persisted as its immutable description. A specific, falsifiable claim " +
                "about what the feature does: what the user does, what should happen, and why it matters. Focus on " +
                "the OUTCOME, not UI mechanics or the dedup argument. This is the loop-stable north star (at least " +
                `${MIN_DESCRIPTION_LENGTH} characters) - it must stand on its own, independent of any other test.`,
        ),
    plan: z
        .string()
        .min(1)
        .describe(
            "The complete, generation-ready natural-language test plan body. Write the full instructions a " +
                "generator can turn directly into steps - not a high-level summary. This is the final plan; there " +
                "is no later refinement of the wording before it runs.",
        ),
    scenarioId: z
        .string()
        .optional()
        .describe(
            "Id of the scenario whose seeded data this test depends on (obtained from `list_scenarios` / " +
                "`read_scenario`). Provide when the test needs preconditions like an authenticated user or " +
                "pre-existing records. Omit for tests that start from a fresh, unauthenticated state.",
        ),
    coverageJustification: z
        .string()
        .min(1)
        .describe(
            "Creation-time deduplication gate (NOT the description): why existing tests do not already cover this " +
                "flow. Name the closest existing tests (by slug) and explain what behavior this test exercises that " +
                "they do not. Required because nothing culls a passing-but-redundant test once it is created, so " +
                "deduplication happens here. Unlike `description`, this is discarded after authoring - it is " +
                "relational (it names sibling tests) and captures only the novel delta, so it is never persisted.",
        ),
});

export type CreatedTest = z.infer<typeof createTestSchema>;

interface CreateTestOutput {
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

/**
 * Action tool: author a brand-new test for behavior the diff introduces that no
 * existing test covers.
 *
 * `create_test` is the sole author of new tests in the diff flow: the runner
 * mints the test case + plan + a pending generation immediately, and the test is
 * generated, run, and healed alongside the affected tests. There is no pre-gate
 * that culls a passing-but-redundant test, so the boundary validates the folder
 * + scenario and the schema forces both a `description` (the durable intent,
 * length-checked, persisted) and a `coverageJustification` (the creation-time
 * dedup gate, transient); redundancy must be ruled out here.
 */
export class CreateTestTool extends AgentTool<CreatedTest, CreateTestOutput, DiffsAgentLoop> {
    constructor() {
        super({
            name: "create_test",
            description:
                "Author a brand-new test for user-facing behavior the diff introduces that no existing test covers. " +
                "The test is created immediately (test case + plan + a pending generation) and is generated, run, and " +
                "healed alongside the affected tests - there is no later review gate, so only create tests you are " +
                "confident are real, non-redundant flows. Provide a `description` (the durable intent: a specific, " +
                "falsifiable claim about what the feature does) and a separate `coverageJustification` (the " +
                "creation-time argument for why existing tests do not already cover this).",
            inputSchema: createTestSchema,
        });
    }

    protected async execute(input: CreatedTest, loop: DiffsAgentLoop): Promise<CreateTestOutput> {
        if (loop.flowIndex.getFlow(input.folderName) === undefined) throw new UnknownFolderError(input.folderName);
        if (input.scenarioId != null && !loop.scenarioIndex.hasScenario(input.scenarioId)) {
            throw new UnknownScenarioError(input.scenarioId);
        }

        loop.createdTests.push(input);
        return { testName: input.name };
    }
}
