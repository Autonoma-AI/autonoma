import type { PrismaClient } from "@autonoma/db";
import { reporterIssueKindSchema, reporterIssueStatusSchema } from "@autonoma/diffs/analysis";
import type { Logger } from "@autonoma/logger";
import { RegenerateSteps, type TestSuiteUpdater, fetchTestSuiteInfo } from "@autonoma/test-updates";

/** How many issue titles a re-verified test's reason names before it summarizes the rest. */
const MAX_REASON_ISSUE_TITLES = 3;

export interface ReverifyOpenIssuesParams {
    db: PrismaClient;
    /**
     * The open updater on the run's own snapshot, which the re-verification generations are queued through. Call this
     * AFTER the diff-driven half of the stage has queued its own: what is already pending is how a test is recognized
     * as being in the run set, and queueing a second generation for one test deletes the first.
     */
    updater: TestSuiteUpdater;
    logger: Logger;
}

/** One test re-verification added to the run set, with the generation that makes it an investigation target. */
export interface ReverifiedTest {
    slug: string;
    generationId: string;
    /** Why the test is in the run set - passed to the classifier as context, and shown as the finding's reason. */
    reason: string;
}

/**
 * Add the covering tests of the branch's open bug-kind issues to the run set, so an issue whose bug has actually been
 * fixed can resolve.
 *
 * Selection is diff-scoped, and the Reporter's coverage guarantees only force a resolve/carry-forward decision for an
 * issue whose covering tests produced findings in the current run. An issue the diff does not touch is therefore left
 * untouched forever: the bug stays `open` and the branch's headline verdict stays pinned to `client_bug` long after
 * the fix landed. Re-running the covering tests is what closes that loop.
 *
 * An issue's covered set is taken **atomically**: a covering test the run's suite no longer assigns (or assigns
 * without a plan) has nothing to queue a generation against, and disqualifies its whole issue. Only `finish`-time
 * coverage (see `computeCoverageViolations`) decides anything, so a set that runs in part costs coverage, never
 * correctness.
 *
 * The extra work is deliberately uncapped: it is bounded by the branch's open-issue count, and a branch carrying
 * enough open issues for that to hurt is itself the signal worth seeing.
 */
export async function reverifyOpenIssues({ db, updater, logger }: ReverifyOpenIssuesParams): Promise<ReverifiedTest[]> {
    const issues = await db.analysisIssue.findMany({
        where: {
            branchId: updater.branchId,
            status: reporterIssueStatusSchema.enum.open,
            // Only a bug is something a re-run can settle: an environment or scenario problem is not a claim about
            // the application, so passing the covering test says nothing about it.
            kind: reporterIssueKindSchema.enum.bug,
        },
        // The covered set, derived rather than stored: the tests of the findings attributed to this issue. A
        // carried-forward issue attributes one finding per (snapshot, test), so the read is per test - the row set is
        // the covered set rather than the branch's history of it.
        select: {
            id: true,
            title: true,
            findings: { select: { testCase: { select: { slug: true } } }, distinct: ["testCaseId"] },
        },
    });
    if (issues.length === 0) {
        logger.info("Re-verification found no open bug issues on the branch");
        return [];
    }

    const [reverifiable, alreadyTargeted] = await Promise.all([
        loadReverifiableTests(db, updater.snapshotId),
        loadTargetedTestCaseIds(db, updater.snapshotId),
    ]);

    const candidates = new Map<string, ReverificationCandidate>();
    let skippedIssues = 0;

    for (const issue of issues) {
        const covered = resolveCoveredSet(issue.findings, reverifiable);
        if (covered.tests.length === 0 || covered.missingSlugs.length > 0) {
            skippedIssues += 1;
            // An operator's problem, not a passing detail: while a covering test is missing, this issue can only ever
            // be closed by hand, and until it is the branch's verdict stays red.
            logger.warn("Cannot re-verify an open issue: the run's suite does not cover it in full", {
                extra: {
                    issueId: issue.id,
                    covering: covered.tests.length + covered.missingSlugs.length,
                    missingSlugs: covered.missingSlugs,
                },
            });
            continue;
        }

        for (const test of covered.tests) {
            const candidate = candidates.get(test.slug);
            if (candidate == null) {
                candidates.set(test.slug, { testCaseId: test.testCaseId, issueTitles: [issue.title] });
            } else {
                candidate.issueTitles.push(issue.title);
            }
        }
    }

    const reverified = await queueReverifications(candidates, alreadyTargeted, updater, logger);
    logger.info("Re-verification added the covering tests of the branch's open bug issues to the run set", {
        extra: {
            openBugIssues: issues.length,
            skippedIssues,
            covered: candidates.size,
            added: reverified.length,
            slugs: reverified.map((test) => test.slug),
        },
    });
    return reverified;
}

/** A test some open issue covers, with every issue title it re-verifies (one test can cover more than one). */
interface ReverificationCandidate {
    testCaseId: string;
    issueTitles: string[];
}

/**
 * Queue one generation per covering test that is not already in the run set. Sequential because the applies share the
 * snapshot draft, and best-effort per test: this stage runs after the diff selection already wrote to the snapshot, so
 * a single failed queue must not fail the run and discard that work.
 */
async function queueReverifications(
    candidates: ReadonlyMap<string, ReverificationCandidate>,
    alreadyTargeted: ReadonlySet<string>,
    updater: TestSuiteUpdater,
    logger: Logger,
): Promise<ReverifiedTest[]> {
    const reverified: ReverifiedTest[] = [];
    for (const [slug, candidate] of candidates) {
        if (alreadyTargeted.has(candidate.testCaseId)) continue;
        try {
            const generationId = await updater.apply(new RegenerateSteps({ testCaseId: candidate.testCaseId }));
            reverified.push({ slug, generationId, reason: buildReason(candidate.issueTitles) });
        } catch (error) {
            logger.warn("Failed to queue a re-verification generation; leaving the test out of the run set", {
                err: error,
                extra: { slug },
            });
        }
    }
    return reverified;
}

interface CoveredSet {
    tests: { slug: string; testCaseId: string }[];
    /** Covering tests this run cannot re-verify - their presence disqualifies the whole issue. */
    missingSlugs: string[];
}

/** Resolve an issue's covering tests against what this run can re-verify, keeping the two outcomes apart. */
function resolveCoveredSet(
    findings: { testCase: { slug: string } }[],
    reverifiable: ReadonlyMap<string, string>,
): CoveredSet {
    const covered: CoveredSet = { tests: [], missingSlugs: [] };
    for (const slug of new Set(findings.map((finding) => finding.testCase.slug))) {
        const testCaseId = reverifiable.get(slug);
        if (testCaseId == null) covered.missingSlugs.push(slug);
        else covered.tests.push({ slug, testCaseId });
    }
    return covered;
}

/**
 * slug -> testCaseId for the tests the run's snapshot assigns WITH a plan. A covering test the suite has since
 * dropped - or holds without a plan - has nothing to queue a generation against, so it cannot be re-verified.
 */
async function loadReverifiableTests(db: PrismaClient, snapshotId: string): Promise<Map<string, string>> {
    const suiteInfo = await fetchTestSuiteInfo(db, snapshotId);
    const reverifiable = new Map<string, string>();
    for (const testCase of suiteInfo.testCases) {
        if (testCase.plan != null) reverifiable.set(testCase.slug, testCase.id);
    }
    return reverifiable;
}

/**
 * The test cases the run already targets, read as the snapshot's pending generations: every way a test enters the run
 * set (merge import, authored, affected) leaves one, so this cannot drift from what was really queued.
 */
async function loadTargetedTestCaseIds(db: PrismaClient, snapshotId: string): Promise<Set<string>> {
    const generations = await db.testGeneration.findMany({
        where: { snapshotId, status: "pending" },
        select: { testPlan: { select: { testCaseId: true } } },
    });
    return new Set(generations.map((generation) => generation.testPlan.testCaseId));
}

/**
 * The classifier-facing account of why a re-verified test is in the run set. Deliberately does not say what the run is
 * expected to find: the test is here to be judged on its own evidence, and the Investigator already receives the
 * branch's prior verdicts for it as context.
 */
function buildReason(issueTitles: string[]): string {
    const shown = issueTitles.slice(0, MAX_REASON_ISSUE_TITLES).map((title) => `"${title}"`);
    const remaining = issueTitles.length - shown.length;
    const titles = remaining > 0 ? `${shown.join(", ")} (+${remaining} more)` : shown.join(", ");
    const subject = issueTitles.length === 1 ? "issue" : "issues";
    return `Re-verification: this test is in the run set because it covers the branch's open ${subject} ${titles}, not because the diff touches it. Judge this run on its own evidence.`;
}
