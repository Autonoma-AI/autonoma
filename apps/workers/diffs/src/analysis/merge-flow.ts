import type { PrismaClient } from "@autonoma/db";
import {
    type AssociatedPullRequestsReader,
    type Classification,
    type MergeClassifierRow,
    type MergeClassifierSource,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
    type RelevantMerge,
    buildMergeClassifierRows,
    classifyTestsForMerge,
    detectRelevantMerges,
    isBaseAncestorOfHead,
    listCommitsInRange,
} from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { OpenSnapshot, TestSuiteStore } from "@autonoma/test-suite";
import { pinMergeSource } from "./pin-merge-source";

const logger = rootLogger.child({ name: "runMergeFlow" });

export interface RunMergeFlowParams {
    db: PrismaClient;
    /** The suite module's entry point, for the lineage reads the merge flow makes. */
    store: TestSuiteStore;
    /**
     * The run's own open snapshot. Every suite edit the merge produces goes through it, so an imported test lands
     * in the same snapshot the rest of the stage reads.
     */
    snapshot: OpenSnapshot;
    githubClient: AssociatedPullRequestsReader;
    owner: string;
    repo: string;
    /**
     * Short branch name of the branch currently being processed (e.g. "main"),
     * sourced from GitHub - typically the repo's `defaultBranch`. Must be the
     * short name, not a fully-qualified ref like "refs/heads/main". Do NOT
     * pass `branch.githubRef` from the DB; that column is being deprecated.
     */
    targetBranchRef: string;
    baseSha: string;
    headSha: string;
    repoDir: string;
}

/** A test whose winning plan this run imported from a merged branch. */
export interface MergeImportedTest {
    slug: string;
    /** The test itself - what the import's investigation target is keyed on. */
    testCaseId: string;
    /** Why the test is in the run set, handed to the classifier as context. */
    reason: string;
}

export interface MergeFlowResult {
    /** Merges successfully pinned to an active source snapshot - to be rendered in the DiffsAgent prompt. */
    merges: MergeContextInfo[];
    /** Tests the classifier flagged as `conflict`; the agent enriches each with reasoning. */
    preClassifiedConflicts: PreClassifiedConflictInfo[];
    /** Tests classified `unilateral_update` (source winning) or `new_test`, imported into the target snapshot. */
    imports: MergeImportedTest[];
    /** Slugs dropped from the target suite because a merged branch deleted them and the target had not touched them. */
    removedSlugs: string[];
}

export const EMPTY_MERGE_FLOW_RESULT: MergeFlowResult = {
    merges: [],
    preClassifiedConflicts: [],
    imports: [],
    removedSlugs: [],
};

/** What one classification asks the flow to write, resolved before any suite edit happens. */
interface MergeImportIntent {
    slug: string;
    testCaseId: string;
    /** The source plan that won. Its prose is copied onto a plan of the target snapshot's own. */
    winningPlanId: string;
    /** True when the target snapshot does not assign this test yet, so the import must adopt it. */
    isNewToTarget: boolean;
    reason: string;
}

/**
 * Absorb the test-plan work of the PRs that merged into the target branch since its last run:
 *   1. Enumerate commits in [baseSha, headSha].
 *   2. For each commit, find PRs merged into the target branch.
 *   3. For each such PR, pin the source branch snapshot at the PR's head SHA.
 *   4. Load target + source assignments and run the deterministic classifier.
 *   5. Apply each outcome on the run's own snapshot: a plan the branch changed while the target stood still is
 *      imported (`revisePlan`, or `adoptTest` for a test the target does not have yet), and a test the branch
 *      deleted from an untouched target is dropped (`dropTest`). No run is started here - the caller targets each
 *      imported test, and the Investigator starts its own runs.
 *   6. Return every `conflict` classification as a pre-classified conflict for the agent to enrich with reasoning.
 *
 * Any PR whose source snapshot cannot be pinned (no branch registered, no active snapshot at the exact head SHA)
 * silently falls back: its commits are processed by the agent as normal `code_change`.
 */
export async function runMergeFlow(params: RunMergeFlowParams): Promise<MergeFlowResult> {
    const { db, store, snapshot, githubClient, owner, repo, targetBranchRef, baseSha, headSha, repoDir } = params;

    const [commits, baseIsAncestor] = await Promise.all([
        // A range git cannot read at all (a base that is no longer in the clone) degrades to the same designed
        // fallback as a truncated one - the agent re-derives the whole range from the diff - so it must not fail the
        // run. The warning is the only thing standing between that and an invisible loss of merged plan work.
        listCommitsInRange(repoDir, baseSha, headSha).catch((err) => {
            logger.warn("Could not enumerate the commit range; every merge in it falls back to the code_change path", {
                extra: { baseSha, headSha, err },
            });
            return [];
        }),
        isBaseAncestorOfHead(repoDir, baseSha, headSha),
    ]);

    // The clone is shallow with the base fetched as a separate graft, so a base that has fallen outside it yields a
    // range that under-reports without erroring: merges in the missing span are simply not detected.
    if (!baseIsAncestor) {
        logger.warn(
            "Commit range may be truncated: this clone cannot connect base to head, so merges in the span it is missing go undetected",
            { extra: { baseSha, headSha, commitsFound: commits.length } },
        );
    }

    if (commits.length === 0) {
        logger.info("Empty commit range; no merges to process");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const relevantMerges = await detectRelevantMerges({ commits, githubClient, owner, repo, targetBranchRef });
    if (relevantMerges.length === 0) {
        logger.info("No PR-based merges in range");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const pinnedSources = await pinMergeSources({
        db,
        applicationId: snapshot.applicationId,
        relevantMerges,
    });
    if (pinnedSources.length === 0) {
        logger.info("No pinnable merge sources; merge matrix shortcut does not fire");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const targetSnapshotId = snapshot.snapshotId;
    const baseSnapshotIds = pinnedSources.map((pinned) => pinned.baseSnapshotId).filter((id) => id != null);
    const inputRows = buildMergeClassifierRows({
        assignments: await store.readAssignments([
            targetSnapshotId,
            ...pinnedSources.map((pinned) => pinned.snapshotId),
            ...baseSnapshotIds,
        ]),
        targetSnapshotId,
        sources: pinnedSources,
    });

    const classifications = classifyTestsForMerge(inputRows);

    const { intents, deletions, preClassifiedConflicts } = partitionClassifications(classifications, inputRows);
    logger.info("Merge classification summary", {
        extra: {
            total: classifications.length,
            imports: intents.length,
            deletions: deletions.length,
            conflicts: preClassifiedConflicts.length,
        },
    });

    const imports = await applyImports({ db, snapshot, intents });
    const removedSlugs = await applyDeletions({ snapshot, deletions });

    const merges: MergeContextInfo[] = pinnedSources.map((pinned) => ({
        prNumber: pinned.prNumber,
        sourceBranchName: pinned.branchName,
        sourceSnapshotId: pinned.snapshotId,
        mergeCommitSha: pinned.merge.mergeCommitSha,
    }));

    return { merges, preClassifiedConflicts, imports, removedSlugs };
}

/** A test the merge propagates a removal for: it existed at the merge base and only the branch touched it. */
interface MergeDeletion {
    slug: string;
    testCaseId: string;
}

/** Split the classifications into the three things the flow does with them: import, delete, or hand to the agent. */
function partitionClassifications(
    classifications: Classification[],
    inputRows: MergeClassifierRow[],
): { intents: MergeImportIntent[]; deletions: MergeDeletion[]; preClassifiedConflicts: PreClassifiedConflictInfo[] } {
    const rowsBySlug = new Map(inputRows.map((row) => [row.slug, row] as const));
    const intents: MergeImportIntent[] = [];
    const deletions: MergeDeletion[] = [];
    const preClassifiedConflicts: PreClassifiedConflictInfo[] = [];

    for (const classification of classifications) {
        const row = rowsBySlug.get(classification.slug);
        if (row == null) continue;

        if (classification.kind === "unilateral_update" || classification.kind === "new_test") {
            const intent = resolveImportIntent(classification, row);
            if (intent != null) intents.push(intent);
            continue;
        }

        if (classification.kind === "unilateral_delete") {
            deletions.push({ slug: row.slug, testCaseId: row.testCaseId });
            continue;
        }

        if (classification.kind === "conflict") {
            preClassifiedConflicts.push(buildPreClassifiedConflict(classification, row));
        }
    }

    return { intents, deletions, preClassifiedConflicts };
}

/**
 * Resolve each merged PR to the source snapshot pinned at its head SHA, dropping the ones that cannot be pinned.
 *
 * One independent read per PR, so they run together; `Promise.all` keeps the merges in range order, which is what
 * makes the source a multi-source classification names deterministic.
 */
async function pinMergeSources({
    db,
    applicationId,
    relevantMerges,
}: {
    db: PrismaClient;
    applicationId: string;
    relevantMerges: RelevantMerge[];
}): Promise<Array<MergeClassifierSource & { merge: RelevantMerge }>> {
    const pinnedSources = await Promise.all(
        relevantMerges.map(async (merge) => {
            const pinned = await pinMergeSource(db, {
                applicationId,
                prNumber: merge.prNumber,
                sourceHeadSha: merge.sourceHeadSha,
            });
            if (pinned == null) {
                logger.info("Merge source could not be pinned; falling back to code_change path", {
                    extra: { prNumber: merge.prNumber, sourceHeadSha: merge.sourceHeadSha },
                });
                return undefined;
            }
            return {
                snapshotId: pinned.snapshotId,
                branchName: pinned.branchName,
                prNumber: merge.prNumber,
                baseSnapshotId: pinned.baseSnapshotId,
                merge,
            };
        }),
    );

    return pinnedSources.filter((pinned) => pinned != null);
}

/**
 * Copy each winning plan's prose onto the target snapshot. A winning leg with no plan is skipped: there would be
 * nothing to run.
 */
async function applyImports({
    db,
    snapshot,
    intents,
}: {
    db: PrismaClient;
    snapshot: OpenSnapshot;
    intents: MergeImportIntent[];
}): Promise<MergeImportedTest[]> {
    if (intents.length === 0) return [];

    const plans = await db.testPlan.findMany({
        where: { id: { in: intents.map((intent) => intent.winningPlanId) } },
        select: { id: true, prompt: true, scenarioId: true },
    });
    const planById = new Map(plans.map((plan) => [plan.id, plan]));

    const imported: MergeImportedTest[] = [];
    for (const intent of intents) {
        const plan = planById.get(intent.winningPlanId);
        if (plan == null) {
            logger.warn("Winning plan no longer exists; skipping import", {
                extra: { slug: intent.slug, planId: intent.winningPlanId },
            });
            continue;
        }

        const planParams = {
            testCaseId: intent.testCaseId,
            plan: plan.prompt,
            scenarioId: plan.scenarioId ?? undefined,
        };
        if (intent.isNewToTarget) {
            await snapshot.adoptTest(planParams);
        } else {
            await snapshot.revisePlan(planParams);
        }

        logger.info("Imported merged plan into the target snapshot", {
            extra: { slug: intent.slug, isNewToTarget: intent.isNewToTarget },
        });
        imported.push({ slug: intent.slug, testCaseId: intent.testCaseId, reason: intent.reason });
    }

    return imported;
}

/** Propagate the branch deletions to the target suite. Nothing is run or investigated for a removed test. */
async function applyDeletions({
    snapshot,
    deletions,
}: {
    snapshot: OpenSnapshot;
    deletions: MergeDeletion[];
}): Promise<string[]> {
    const removedSlugs: string[] = [];

    for (const deletion of deletions) {
        await snapshot.dropTest(deletion.testCaseId);
        logger.info("Propagated a merged branch's test deletion to the target snapshot", {
            extra: { slug: deletion.slug },
        });
        removedSlugs.push(deletion.slug);
    }

    return removedSlugs;
}

/**
 * The write a plan-level classification asks for, or null when there is nothing to write: the target already holds
 * the winning plan, or the winning leg carries no plan to copy.
 */
function resolveImportIntent(
    classification: Extract<Classification, { kind: "unilateral_update" | "new_test" }>,
    row: MergeClassifierRow,
): MergeImportIntent | null {
    const { winningFrom } = classification;
    if (winningFrom === "target") {
        // Target already has the winning plan in place. No import or run is triggered here; the agent's
        // code_change pass runs independently and will flag this test if the diff warrants it.
        return null;
    }

    const sourceRow = row.sources.find(
        (source) => source.prNumber === winningFrom.prNumber && source.sourceName === winningFrom.sourceName,
    );
    const winningPlanId = sourceRow?.leg?.planId;
    if (winningPlanId == null) {
        logger.warn("Winning merge leg has no plan to import; leaving the test to the agent", {
            extra: { slug: row.slug, prNumber: winningFrom.prNumber },
        });
        return null;
    }

    return {
        slug: row.slug,
        testCaseId: row.testCaseId,
        winningPlanId,
        isNewToTarget: classification.kind === "new_test",
        reason:
            classification.kind === "new_test"
                ? newTestReason(winningFrom.prNumber, winningFrom.sourceName)
                : importedPlanReason(winningFrom.prNumber, winningFrom.sourceName),
    };
}

function importedPlanReason(prNumber: number, sourceName: string): string {
    return `Plan imported from merged PR #${prNumber} (${sourceName}), which changed this test while this branch left it untouched - run it to confirm the merged code still supports it.`;
}

function newTestReason(prNumber: number, sourceName: string): string {
    return `Test authored on merged PR #${prNumber} (${sourceName}) and adopted into this branch's suite - run it to confirm the merged code supports the scenario it covers.`;
}

function buildPreClassifiedConflict(
    classification: Extract<Classification, { kind: "conflict" }>,
    row: MergeClassifierRow,
): PreClassifiedConflictInfo {
    const versions: PreClassifiedConflictVersion[] = classification.versions.map((version) => {
        if (version.role === "source") {
            return {
                role: "source" as const,
                sourceName: version.sourceName,
                prNumber: version.prNumber,
                assignmentId: version.ref.assignmentId,
                planId: version.ref.planId,
            };
        }
        return {
            role: version.role,
            assignmentId: version.ref.assignmentId,
            planId: version.ref.planId,
        };
    });

    return {
        slug: classification.slug,
        testName: row.testName,
        versions,
        involvedPrNumbers: classification.involvedPrNumbers,
    };
}
