import type { PrismaClient } from "@autonoma/db";
import {
    type AssociatedPullRequestsReader,
    type Classification,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
    type RelevantMerge,
    classifyTestsForMerge,
    detectRelevantMerges,
    isBaseAncestorOfHead,
    listCommitsInRange,
} from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type ClassifierInputRow,
    ImportTest,
    type PinnedSourceForClassifier,
    RemoveTest,
    type TestSuiteUpdater,
    UpdateTest,
    buildMergeClassifierInputs,
    findMergeSourceSnapshot,
} from "@autonoma/test-updates";

export interface RunMergeFlowParams {
    db: PrismaClient;
    /**
     * The updater for the run's own snapshot. Every suite edit the merge produces goes through it, so an imported
     * test lands in the same draft the rest of the stage reads and arrives with a generation already queued.
     */
    updater: TestSuiteUpdater;
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

/** A test whose winning plan this run imported from a merged branch, plus the generation the import queued. */
export interface MergeImportedTest {
    slug: string;
    /** The queued generation - what makes the imported test a real investigation target rather than a silent write. */
    generationId: string;
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
 *   5. Apply each outcome through the canonical update actions on the run's own snapshot: a plan the branch changed
 *      while the target stood still is imported (`UpdateTest`, or `ImportTest` for a test the target does not have
 *      yet), and a test the branch deleted from an untouched target is dropped (`RemoveTest`). Each import queues a
 *      generation, which is what turns it into an investigation target for this run.
 *   6. Return every `conflict` classification as a pre-classified conflict for the agent to enrich with reasoning.
 *
 * Any PR whose source snapshot cannot be pinned (no branch registered, no active snapshot at the exact head SHA)
 * silently falls back: its commits are processed by the agent as normal `code_change`.
 */
export async function runMergeFlow(params: RunMergeFlowParams): Promise<MergeFlowResult> {
    const { db, updater, githubClient, owner, repo, targetBranchRef, baseSha, headSha, repoDir } = params;
    const logger = rootLogger.child({ name: "runMergeFlow", extra: { targetBranchRef } });

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
        applicationId: updater.applicationId,
        relevantMerges,
        logger,
    });
    if (pinnedSources.length === 0) {
        logger.info("No pinnable merge sources; merge matrix shortcut does not fire");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const inputRows = await buildMergeClassifierInputs({
        db,
        targetSnapshotId: updater.snapshotId,
        sources: pinnedSources.map((pinned) => ({
            snapshotId: pinned.snapshotId,
            branchName: pinned.branchName,
            prNumber: pinned.prNumber,
            baseSnapshotId: pinned.baseSnapshotId,
        })),
    });

    const classifications = classifyTestsForMerge(
        inputRows.map((row) => ({ slug: row.slug, target: row.target, sources: row.sources })),
    );

    const { intents, deletions, preClassifiedConflicts } = partitionClassifications(classifications, inputRows, logger);
    logger.info("Merge classification summary", {
        extra: {
            total: classifications.length,
            imports: intents.length,
            deletions: deletions.length,
            conflicts: preClassifiedConflicts.length,
        },
    });

    const imports = await applyImports({ db, updater, intents, logger });
    const removedSlugs = await applyDeletions({ updater, deletions, logger });

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
    inputRows: ClassifierInputRow[],
    logger: Logger,
): { intents: MergeImportIntent[]; deletions: MergeDeletion[]; preClassifiedConflicts: PreClassifiedConflictInfo[] } {
    const rowsBySlug = new Map(inputRows.map((row) => [row.slug, row] as const));
    const intents: MergeImportIntent[] = [];
    const deletions: MergeDeletion[] = [];
    const preClassifiedConflicts: PreClassifiedConflictInfo[] = [];

    for (const classification of classifications) {
        const row = rowsBySlug.get(classification.slug);
        if (row == null) continue;

        if (classification.kind === "unilateral_update" || classification.kind === "new_test") {
            const intent = resolveImportIntent(classification, row, logger);
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
    logger,
}: {
    db: PrismaClient;
    applicationId: string;
    relevantMerges: RelevantMerge[];
    logger: Logger;
}): Promise<Array<PinnedSourceForClassifier & { merge: RelevantMerge }>> {
    const pinnedSources = await Promise.all(
        relevantMerges.map(async (merge) => {
            const pinned = await findMergeSourceSnapshot({
                db,
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
 * Copy each winning plan's prose onto the target snapshot through the update actions, queueing the generation that
 * makes the imported test an investigation target. A winning leg with no plan is skipped: there would be nothing to
 * generate or run from.
 */
async function applyImports({
    db,
    updater,
    intents,
    logger,
}: {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    intents: MergeImportIntent[];
    logger: Logger;
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
        const { generationId } = intent.isNewToTarget
            ? await updater.apply(new ImportTest(planParams))
            : await updater.apply(new UpdateTest(planParams));

        logger.info("Imported merged plan into the target snapshot", {
            extra: { slug: intent.slug, isNewToTarget: intent.isNewToTarget, generationId },
        });
        imported.push({ slug: intent.slug, generationId, reason: intent.reason });
    }

    return imported;
}

/** Propagate the branch deletions to the target suite. Nothing is generated or investigated for a removed test. */
async function applyDeletions({
    updater,
    deletions,
    logger,
}: {
    updater: TestSuiteUpdater;
    deletions: MergeDeletion[];
    logger: Logger;
}): Promise<string[]> {
    const removedSlugs: string[] = [];

    for (const deletion of deletions) {
        await updater.apply(new RemoveTest({ testCaseId: deletion.testCaseId }));
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
    row: ClassifierInputRow,
    logger: Logger,
): MergeImportIntent | null {
    const { winningFrom } = classification;
    if (winningFrom === "target") {
        // Target already has the winning plan in place. No import or replay is triggered here; the agent's
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
    row: ClassifierInputRow,
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
