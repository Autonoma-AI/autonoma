import type { PrismaClient } from "@autonoma/db";
import {
    type AffectedTest,
    type Classification,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
    type RelevantMerge,
    classifyTestsForMerge,
    detectRelevantMerges,
    listCommitsInRange,
} from "@autonoma/diffs";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import {
    type ClassifierInputRow,
    type PinnedSourceForClassifier,
    applyMergePlanImports,
    buildMergeClassifierInputs,
    findMergeSourceSnapshot,
} from "@autonoma/test-updates";

export interface RunMergeFlowParams {
    db: PrismaClient;
    githubClient: GitHubInstallationClient;
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
    targetSnapshotId: string;
    applicationId: string;
}

export interface MergeFlowResult {
    /** Merges successfully pinned to an active source snapshot - to be rendered in the DiffsAgent prompt. */
    merges: MergeContextInfo[];
    /** Tests the classifier flagged as `conflict`; the agent enriches each with reasoning. */
    preClassifiedConflicts: PreClassifiedConflictInfo[];
    /**
     * Tests classified as `unilateral_update` or `new_test` whose winning plan
     * has already been written into the target snapshot's assignments. These
     * should be dispatched to replay with `affectedReason: merge_plan_imported`
     * and merged with the agent's affectedTests before calling `prepareRuns`.
     */
    importedAffectedTests: AffectedTest[];
}

const EMPTY_RESULT: MergeFlowResult = {
    merges: [],
    preClassifiedConflicts: [],
    importedAffectedTests: [],
};

/**
 * Phase 1 MVP merge flow:
 *   1. Enumerate commits in [baseSha, headSha].
 *   2. For each commit, find PRs merged into the target branch.
 *   3. For each such PR, pin the source branch snapshot at the PR's head SHA.
 *   4. Load target + source assignments and run the deterministic classifier.
 *   5. For every `unilateral_update` and `new_test` classification, write the
 *      winning plan/steps into the target snapshot and synthesize an
 *      AffectedTest entry with `affectedReason: "merge_plan_imported"` so the
 *      test is replayed without going through the agent.
 *   6. Return every `conflict` classification as a pre-classified conflict for
 *      the agent to enrich with reasoning.
 *
 * Any PR whose source snapshot cannot be pinned (no branch registered, no
 * active snapshot at the exact head SHA) silently falls back: its commits are
 * processed by the agent as normal `code_change`.
 */
export async function runMergeFlow(params: RunMergeFlowParams): Promise<MergeFlowResult> {
    const logger = rootLogger.child({
        name: "runMergeFlow",
        targetSnapshotId: params.targetSnapshotId,
        targetBranchRef: params.targetBranchRef,
    });
    const {
        db,
        githubClient,
        owner,
        repo,
        targetBranchRef,
        baseSha,
        headSha,
        repoDir,
        targetSnapshotId,
        applicationId,
    } = params;

    const commits = await listCommitsInRange(repoDir, baseSha, headSha);
    if (commits.length === 0) {
        logger.info("Empty commit range; no merges to process");
        return EMPTY_RESULT;
    }

    const relevantMerges = await detectRelevantMerges({
        commits,
        githubClient,
        owner,
        repo,
        targetBranchRef,
    });

    if (relevantMerges.length === 0) {
        logger.info("No PR-based merges in range");
        return EMPTY_RESULT;
    }

    const pinnedSources: Array<PinnedSourceForClassifier & { merge: RelevantMerge }> = [];
    for (const merge of relevantMerges) {
        const pinned = await findMergeSourceSnapshot({
            db,
            applicationId,
            prNumber: merge.prNumber,
            sourceHeadSha: merge.sourceHeadSha,
        });
        if (pinned == null) {
            logger.info("Merge source could not be pinned; falling back to code_change path", {
                prNumber: merge.prNumber,
                sourceHeadSha: merge.sourceHeadSha,
            });
            continue;
        }
        pinnedSources.push({
            snapshotId: pinned.snapshotId,
            branchName: pinned.branchName,
            prNumber: merge.prNumber,
            baseSnapshotId: pinned.baseSnapshotId,
            merge,
        });
    }

    if (pinnedSources.length === 0) {
        logger.info("No pinnable merge sources; merge matrix shortcut does not fire");
        return EMPTY_RESULT;
    }

    const inputRows = await buildMergeClassifierInputs({
        db,
        targetSnapshotId,
        sources: pinnedSources.map((p) => ({
            snapshotId: p.snapshotId,
            branchName: p.branchName,
            prNumber: p.prNumber,
            baseSnapshotId: p.baseSnapshotId,
        })),
    });

    const classifications = classifyTestsForMerge(
        inputRows.map((row) => ({
            slug: row.slug,
            target: row.target,
            sources: row.sources,
        })),
    );

    const rowsBySlug = new Map(inputRows.map((row) => [row.slug, row] as const));
    const imports: Array<{ slug: string; sourceAssignmentId: string; testName: string; reasoning: string }> = [];
    const preClassifiedConflicts: PreClassifiedConflictInfo[] = [];

    for (const classification of classifications) {
        const row = rowsBySlug.get(classification.slug);
        if (row == null) continue;

        if (classification.kind === "unilateral_update" || classification.kind === "new_test") {
            const importable = resolveImportable(classification, row);
            if (importable == null) continue;
            imports.push(importable);
            continue;
        }

        if (classification.kind === "conflict") {
            preClassifiedConflicts.push(buildPreClassifiedConflict(classification, row));
        }
    }

    logger.info("Merge classification summary", {
        total: classifications.length,
        imports: imports.length,
        conflicts: preClassifiedConflicts.length,
    });

    const applied = await applyMergePlanImports({
        db,
        targetSnapshotId,
        imports: imports.map((i) => ({ sourceAssignmentId: i.sourceAssignmentId })),
    });
    const appliedSlugs = new Set(applied.map((a) => a.slug));

    const importedAffectedTests: AffectedTest[] = imports
        .filter((i) => appliedSlugs.has(i.slug))
        .map((i) => ({
            slug: i.slug,
            testName: i.testName,
            affectedReason: "merge_plan_imported" as const,
            reasoning: i.reasoning,
        }));

    const merges: MergeContextInfo[] = pinnedSources.map((p) => ({
        prNumber: p.prNumber,
        sourceBranchName: p.branchName,
        sourceSnapshotId: p.snapshotId,
        mergeCommitSha: p.merge.mergeCommitSha,
    }));

    return { merges, preClassifiedConflicts, importedAffectedTests };
}

function resolveImportable(
    classification: Extract<Classification, { kind: "unilateral_update" | "new_test" }>,
    row: ClassifierInputRow,
): { slug: string; sourceAssignmentId: string; testName: string; reasoning: string } | null {
    if (classification.kind === "unilateral_update") {
        const winningFrom = classification.winningFrom;
        if (winningFrom === "target") {
            // Target already has the winning plan in place. No import or replay is
            // triggered here; the agent's code_change pass runs independently and
            // will flag this test if the diff warrants it.
            return null;
        }
        const sourceRow = row.sources.find(
            (s) => s.prNumber === winningFrom.prNumber && s.sourceName === winningFrom.sourceName,
        );
        if (sourceRow?.leg == null) return null;
        return {
            slug: classification.slug,
            sourceAssignmentId: sourceRow.leg.assignmentId,
            testName: row.testName,
            reasoning: `Imported plan from PR #${winningFrom.prNumber} (${winningFrom.sourceName}); target was unchanged relative to the merge base.`,
        };
    }

    const sourceRow = row.sources.find(
        (s) =>
            s.prNumber === classification.winningFrom.prNumber &&
            s.sourceName === classification.winningFrom.sourceName,
    );
    if (sourceRow?.leg == null) return null;
    return {
        slug: classification.slug,
        sourceAssignmentId: sourceRow.leg.assignmentId,
        testName: row.testName,
        reasoning: `New test introduced by PR #${classification.winningFrom.prNumber} (${classification.winningFrom.sourceName}); adopted as-is into target.`,
    };
}

function buildPreClassifiedConflict(
    classification: Extract<Classification, { kind: "conflict" }>,
    row: ClassifierInputRow,
): PreClassifiedConflictInfo {
    const versions: PreClassifiedConflictVersion[] = classification.versions.map((v) => {
        if (v.role === "source") {
            return {
                role: "source" as const,
                sourceName: v.sourceName,
                prNumber: v.prNumber,
                assignmentId: v.ref.assignmentId,
                planId: v.ref.planId,
            };
        }
        return {
            role: v.role,
            assignmentId: v.ref.assignmentId,
            planId: v.ref.planId,
        };
    });

    return {
        slug: classification.slug,
        testName: row.testName,
        versions,
        involvedPrNumbers: classification.involvedPrNumbers,
    };
}
