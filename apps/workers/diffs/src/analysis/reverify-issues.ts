import { AnalysisStore, type CoveredIssue } from "@autonoma/analysis";
import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { OpenSnapshot } from "@autonoma/test-suite";

const logger = rootLogger.child({ name: "reverifyOpenIssues" });

/** How many issue titles a re-verified test's reason names before it summarizes the rest. */
const MAX_REASON_ISSUE_TITLES = 3;

export interface ReverifyOpenIssuesParams {
    db: PrismaClient;
    /** The run's own open snapshot - whose suite decides which covering tests can be re-verified. */
    snapshot: OpenSnapshot;
}

/** One test re-verification added to the run set. */
export interface ReverifiedTest {
    slug: string;
    testCaseId: string;
    /** Why the test is in the run set - passed to the classifier as context, and shown as the finding's reason. */
    reason: string;
}

/**
 * Select the covering tests of the branch's open issues (every kind - `bug`, `environment`, `scenario`) for the run
 * set, so an issue whose underlying problem has actually been fixed can resolve.
 *
 * Selection is diff-scoped, and the Reporter's coverage guarantees only force a resolve/carry-forward decision for an
 * issue whose covering tests produced findings in the current run. An issue the diff does not touch is therefore left
 * untouched forever: it stays `open` long after the fix landed - a bug keeps the branch's headline verdict pinned to
 * `client_bug`, and an environment/scenario gap keeps a stale "yours to fix" card on the PR comment. Re-running the
 * covering tests is what closes that loop.
 *
 * An issue's covered set - the ledger's `coveredTestsForOpenIssues` - is taken **atomically**: a covering test the
 * run's suite no longer assigns (or assigns without a plan) has nothing to run, and disqualifies its whole issue.
 * Only `finish`-time coverage (see `computeCoverageViolations`) decides anything, so a set that runs in part costs
 * coverage, never correctness.
 *
 * The extra work is deliberately uncapped: it is bounded by the branch's open-issue count, and a branch carrying
 * enough open issues for that to hurt is itself the signal worth seeing.
 *
 * Pure selection: no suite write happens here, and a test the run already targets is deduplicated by the caller's
 * target assembly.
 */
export async function reverifyOpenIssues({ db, snapshot }: ReverifyOpenIssuesParams): Promise<ReverifiedTest[]> {
    const issues = await new AnalysisStore(db).forBranch(snapshot.branchId).coveredTestsForOpenIssues();
    if (issues.length === 0) {
        logger.info("Re-verification found no open issues on the branch");
        return [];
    }

    const reverifiable = await loadReverifiableTests(snapshot);

    const candidates = new Map<string, ReverificationCandidate>();
    let skippedIssues = 0;

    for (const issue of issues) {
        const covered = resolveCoveredSet(issue, reverifiable);
        if (covered.tests.length === 0 || covered.missingSlugs.length > 0) {
            skippedIssues += 1;
            // An operator's problem, not a passing detail: while a covering test is missing, this issue can only be
            // closed by hand - a bug keeps the branch verdict red, an environment/scenario gap a stale PR card.
            logger.warn("Cannot re-verify an open issue: the run's suite does not cover it in full", {
                extra: {
                    issueId: issue.issueId,
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

    const reverified = Array.from(candidates, ([slug, candidate]) => ({
        slug,
        testCaseId: candidate.testCaseId,
        reason: buildReason(candidate.issueTitles),
    }));
    logger.info("Re-verification selected the covering tests of the branch's open issues", {
        extra: {
            openIssues: issues.length,
            skippedIssues,
            covered: candidates.size,
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

interface CoveredSet {
    tests: { slug: string; testCaseId: string }[];
    /** Covering tests this run cannot re-verify - their presence disqualifies the whole issue. */
    missingSlugs: string[];
}

/** Resolve an issue's covering tests against what this run can re-verify, keeping the two outcomes apart. */
function resolveCoveredSet(issue: CoveredIssue, reverifiable: ReadonlyMap<string, string>): CoveredSet {
    const covered: CoveredSet = { tests: [], missingSlugs: [] };
    for (const test of issue.coveredTests) {
        const testCaseId = reverifiable.get(test.slug);
        if (testCaseId == null) covered.missingSlugs.push(test.slug);
        else covered.tests.push({ slug: test.slug, testCaseId });
    }
    return covered;
}

/**
 * slug -> testCaseId for the tests the run's snapshot assigns WITH a plan. A covering test the suite has since
 * dropped - or holds without a plan - has nothing to run, so it cannot be re-verified.
 */
async function loadReverifiableTests(snapshot: OpenSnapshot): Promise<Map<string, string>> {
    const suite = await snapshot.read();
    const reverifiable = new Map<string, string>();
    for (const testCase of suite.testCases) {
        if (testCase.plan != null) reverifiable.set(testCase.slug, testCase.id);
    }
    return reverifiable;
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
