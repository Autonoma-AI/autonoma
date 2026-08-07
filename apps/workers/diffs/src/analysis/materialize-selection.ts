import type { AffectedReason } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { OpenSnapshot } from "@autonoma/test-suite";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "materializeSelection" });

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

/**
 * Materialize the agent's selection on the run's own snapshot as investigation targets.
 *
 * A new test is authored onto the snapshot (`addTest` mints test case + plan + assignment) and targeted as
 * `proposed` - the TestCase exists only for this run, which is what makes its finding read as an added test. An
 * affected test needs no suite write at all: a target is a test, and the Investigator runs whatever plan the
 * snapshot pins - so it is simply targeted as `pre_existing`.
 */
export async function materializeSelection({
    snapshot,
    agentResult,
}: {
    snapshot: OpenSnapshot;
    agentResult: AgentSelection;
}): Promise<AnalysisInvestigationTarget[]> {
    const targets: AnalysisInvestigationTarget[] = [];

    for (const test of agentResult.createdTests) {
        const folderId = agentResult.flowFolderId(test.folderName);
        if (folderId == null) throw new Error(`Folder "${test.folderName}" not found for authored test "${test.name}"`);
        const { testCaseId, slug } = await snapshot.addTest({
            name: test.name,
            description: test.description,
            plan: test.plan,
            folderId: folderId,
            scenarioId: test.scenarioId,
        });
        targets.push({ slug, testCaseId, reason: NEW_TEST_REASON, origin: "proposed" });
    }

    for (const affected of agentResult.affectedTests) {
        const testCaseId = agentResult.testCaseIdBySlug.get(affected.slug);
        if (testCaseId == null) {
            // A merge conflict can name a slug the target snapshot never assigned - two merged sources adding the
            // same test with different plans. There is no pinned plan to run, so the conflict is reported in the
            // agent's reasoning and nothing is targeted for it.
            if (affected.affectedReason === "merge_conflict") {
                logger.info("Conflicting test is not in the snapshot's suite; targeting nothing for it", {
                    extra: { slug: affected.slug },
                });
                continue;
            }
            // `mark_affected_test` only accepts slugs from the agent's Existing Tests list, which is derived from
            // this same suite, so a miss here means those two views of the suite have diverged.
            throw new Error(`Affected test "${affected.slug}" is not in snapshot ${snapshot.snapshotId}'s suite`);
        }
        targets.push({ slug: affected.slug, testCaseId, reason: affected.reasoning, origin: "pre_existing" });
    }

    return targets;
}
