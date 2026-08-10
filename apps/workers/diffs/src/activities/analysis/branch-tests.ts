import { db } from "@autonoma/db";
import { type ReporterBranchTest, reporterIssueKindSchema, reporterIssueStatusSchema } from "@autonoma/diffs/analysis";
import type { Logger } from "@autonoma/logger";
import { ANALYSIS_VERDICT, analysisVerdictSchema } from "@autonoma/types";

/**
 * Ceiling on the finding rows one branch's map is built from. Measured over every branch the product has analyzed:
 * p50 7 rows, p90 32, p99 95, and 735 for the largest (37 snapshots x 238 distinct tests). This is far above that, so
 * it bounds the allocation without truncating any real branch - and it is NOT a silent cap: hitting it logs, because
 * the rows are ordered newest-snapshot-first and dropping the tail would quietly lose exactly the carried verdicts
 * this map exists to surface.
 */
const MAX_BRANCH_FINDING_ROWS = 10_000;

/**
 * The branch's LAST-KNOWN verdict per test, across every snapshot of a pull request - the map the report describes
 * and the flows partition.
 *
 * A pull request accumulates evidence over several commits, and the newest commit alone is a poor account of it: a
 * flow verified two commits ago and not re-selected since was affirmatively judged unaffected by the diffs that
 * followed, so its pass is the best evidence available, and evidence we deliberately chose not to refresh. Taking the
 * most recent verdict per test gets both readings right at once - a test that WAS re-run and then failed supersedes
 * its own earlier pass, because only the newest row per test survives.
 *
 * Two exclusions, both to keep the ratio honest:
 *
 * - An `invalid_test` is a deliberate, evidence-backed removal, reported on its own line. Counting it as an
 *   unverified flow would penalize the run for cleaning the suite up.
 * - A test no longer assigned to this snapshot was removed from the suite while keeping its findings (deleting a test
 *   unassigns it rather than destroying it), so its stale gap would otherwise drag the ratio down for the rest of the
 *   branch's life. Measured on production this drops ~1.8% of a branch's test set, and every one of them is a removal.
 */
export async function loadBranchTests(
    branchId: string,
    snapshotId: string,
    logger: Logger,
): Promise<ReporterBranchTest[]> {
    const [rows, assignments] = await Promise.all([
        db.analysisFinding.findMany({
            where: { job: { snapshot: { branchId } }, currentClassificationId: { not: null } },
            // Newest snapshot first, so the first row seen for a test IS its last-known verdict.
            orderBy: { job: { snapshot: { createdAt: "desc" } } },
            take: MAX_BRANCH_FINDING_ROWS,
            select: {
                testCaseId: true,
                reportSnapshotId: true,
                testCase: { select: { slug: true, name: true } },
                currentClassification: { select: { category: true, headline: true } },
                issue: { select: { status: true, kind: true } },
                job: { select: { snapshot: { select: { headSha: true } } } },
            },
        }),
        db.testCaseAssignment.findMany({ where: { snapshotId }, select: { testCaseId: true } }),
    ]);

    if (rows.length === MAX_BRANCH_FINDING_ROWS) {
        logger.warn("Branch finding history hit the row ceiling; the oldest verdicts are missing from the map", {
            extra: { branchId, ceiling: MAX_BRANCH_FINDING_ROWS },
        });
    }

    const assignedTestCaseIds = new Set(assignments.map((row) => row.testCaseId));
    const resolved = new Set<string>();
    const tests: ReporterBranchTest[] = [];
    let excludedRemoved = 0;
    let excludedUnassigned = 0;

    for (const row of rows) {
        if (resolved.has(row.testCaseId)) continue;
        resolved.add(row.testCaseId);
        const current = row.currentClassification;
        if (current == null) continue;
        if (current.category === ANALYSIS_VERDICT.invalid_test) {
            excludedRemoved += 1;
            continue;
        }
        if (!assignedTestCaseIds.has(row.testCaseId)) {
            excludedUnassigned += 1;
            continue;
        }
        const checkedThisRun = row.reportSnapshotId === snapshotId;
        tests.push({
            slug: row.testCase.slug,
            name: row.testCase.name,
            category: parseVerdict(current.category),
            checkedThisRun,
            attributedToClientIssue: isClientOwnedIssue(row.issue),
            headline: current.headline,
            // Only a carried row needs its provenance; for this commit's tests "when" is already the answer. A
            // snapshot with no head SHA degrades to "an earlier commit" in the prompt rather than dropping the row.
            fromSha: checkedThisRun ? undefined : row.job.snapshot.headSha?.slice(0, 7),
        });
    }

    // Slug order groups a feature's tests together, which is exactly what the agent is being asked to do with them.
    tests.sort((left, right) => left.slug.localeCompare(right.slug));
    logger.info("Resolved the branch's last-known verdict per test", {
        extra: {
            tests: tests.length,
            checkedThisRun: tests.filter((test) => test.checkedThisRun).length,
            excludedRemoved,
            excludedUnassigned,
        },
    });
    return tests;
}

/**
 * Whether a finding's attributed issue puts its gap on the READER's side. Mirrors the placement rule the PR comment
 * already uses: the Reporter opens an environment/scenario issue only for a gap the reader can act on, so an
 * attributed gap is theirs and an unattributed one stays ours. A bug issue is not a coverage placement, and a
 * resolved one is no longer a live gap.
 */
function isClientOwnedIssue(issue: { status: string; kind: string } | null): boolean {
    if (issue == null || issue.status !== reporterIssueStatusSchema.enum.open) return false;
    const kind = reporterIssueKindSchema.safeParse(issue.kind);
    return kind.success && kind.data !== reporterIssueKindSchema.enum.bug;
}

/** A stored category that does not parse is an engine artifact, never a silent drop or a false pass. */
function parseVerdict(category: string) {
    const parsed = analysisVerdictSchema.safeParse(category);
    return parsed.success ? parsed.data : ANALYSIS_VERDICT.engine_artifact;
}
