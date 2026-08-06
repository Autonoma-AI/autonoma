import type { AffectedReason } from "@autonoma/diffs";
import type { Logger } from "@autonoma/logger";
import { AddTest, RegenerateSteps, type TestSuiteUpdater } from "@autonoma/test-updates";
import type { MaterializedTarget } from "./resolve-targets";

/**
 * Why a newly-authored test is in the run set - passed to the classifier as context. The DiffsAgent authors it
 * as a COMPLETE plan for functionality this PR adds, so the run confirms the app supports the scenario it covers.
 */
const NEW_TEST_REASON =
    "New test authored by Impact Analysis for functionality this PR adds - run it to confirm the app supports the scenario it covers.";

/** What the DiffsAgent decided, resolved against the suite the run operates on. */
export interface AgentSelection {
    /** The DiffsAgent's overall summary of what the diff affects and why - the selection reasoning. */
    reasoning: string;
    /**
     * `code_change` entries come from `mark_affected_test`, which only accepts slugs this snapshot assigns.
     * `merge_conflict` entries are seeded from the merge flow's pre-classified conflicts and are NOT validated -
     * a conflict can name a slug the target snapshot does not assign at all.
     */
    affectedTests: { slug: string; reasoning: string; affectedReason: AffectedReason }[];
    createdTests: { name: string; description: string; plan: string; folderName: string; scenarioId?: string }[];
    flowFolderId(folderName: string): string | undefined;
    /** slug -> testCaseId for the tests this snapshot assigns. */
    testCaseIdBySlug: Map<string, string>;
}

/** Materialize the agent's selection on the run's own snapshot via the update actions. */
export async function materializeSelection({
    updater,
    agentResult,
    logger,
}: {
    updater: TestSuiteUpdater;
    agentResult: AgentSelection;
    logger: Logger;
}): Promise<MaterializedTarget[]> {
    const materialized: MaterializedTarget[] = [];

    // New tests first (AddTest mints test case + plan + assignment + queues a generation). Tagged `proposed` because
    // the TestCase exists only for this run, which is what makes its finding read as an added test.
    for (const test of agentResult.createdTests) {
        const folderId = agentResult.flowFolderId(test.folderName);
        if (folderId == null) throw new Error(`Folder "${test.folderName}" not found for authored test "${test.name}"`);
        const { generationId } = await updater.apply(
            new AddTest({
                name: test.name,
                description: test.description,
                plan: test.plan,
                folderId,
                scenarioId: test.scenarioId,
            }),
        );
        materialized.push({ generationId, reason: NEW_TEST_REASON, origin: "proposed" });
    }

    // Affected tests (RegenerateSteps clears the pinned plan's steps + queues a generation to regenerate them).
    // Tagged `pre_existing` because the TestCase is a real suite member this PR's diff affected.
    const materializedTestCaseIds = new Set<string>();
    for (const affected of agentResult.affectedTests) {
        const testCaseId = agentResult.testCaseIdBySlug.get(affected.slug);
        if (testCaseId == null) {
            // A merge conflict can name a slug the target snapshot never assigned - two merged sources adding the
            // same test with different plans. There is no pinned plan to regenerate, so the conflict is reported in
            // the agent's reasoning and nothing is queued for it.
            if (affected.affectedReason === "merge_conflict") {
                logger.info("Conflicting test is not in the snapshot's suite; queueing nothing for it", {
                    extra: { slug: affected.slug },
                });
                continue;
            }
            // `mark_affected_test` only accepts slugs from the agent's Existing Tests list, which is derived from
            // this same suite, so a miss here means those two views of the suite have diverged.
            throw new Error(`Affected test "${affected.slug}" is not in snapshot ${updater.snapshotId}'s suite`);
        }
        // A second RegenerateSteps for one test case deletes the first's pending generation, stranding the target
        // already recorded for it - so the same test is materialized at most once per run.
        if (materializedTestCaseIds.has(testCaseId)) {
            logger.info("Affected test was already materialized this run; ignoring the duplicate", {
                extra: { slug: affected.slug },
            });
            continue;
        }
        materializedTestCaseIds.add(testCaseId);
        const generationId = await updater.apply(new RegenerateSteps({ testCaseId }));
        materialized.push({ generationId, reason: affected.reasoning, origin: "pre_existing" });
    }

    return materialized;
}
