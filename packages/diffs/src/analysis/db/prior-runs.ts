import type { PrismaClient } from "@autonoma/db";
import { Category } from "../schema";

export interface PriorRun {
    day: string;
    /** A plain string rather than `Category`: historical rows carry retired category names. */
    category: string;
}

export interface PriorRunsHistory {
    /**
     * Whether the test has EVER been judged `passed`, over its whole history rather than the recent window.
     * It gets its own query: derived from the window, a test that passed 31 runs ago reads as never having
     * passed, and the prompt turns that into "do not blame the PR".
     */
    everPassed: boolean;
    totalRecent: number;
    passedCount: number;
    /** Day (YYYY-MM-DD) of the most recent pass, over the whole history - not just the recent window. */
    mostRecentPassDay?: string;
    /** Newest first. */
    recent: PriorRun[];
}

export interface PriorRunsQuery {
    applicationId: string;
    testSlug: string;
    /**
     * The snapshot under analysis. Excluded, not merely time-bounded: on a self-heal re-run its finding
     * already exists carrying the earlier iteration's verdict, so no `before` keeps the run being judged from
     * supplying the evidence that judges it.
     */
    currentSnapshotId: string;
    /**
     * Bounds the history to the analyses that existed at a past instant. Production omits it - now is the
     * bound - and it is passed only when freezing a baseline for later replay, where runs analyzed after the
     * frozen classification would otherwise leak into `everPassed` and `mostRecentPassDay`.
     */
    before?: Date;
}

const MAX_RECENT_RUNS = 30;
const RECENT_RUNS_TO_SHOW = 10;

export class PriorRuns {
    constructor(private readonly db: PrismaClient) {}

    /**
     * Read from the classifier's own record, not `TestGeneration.status`: a generation's status says the
     * ENGINE finished, and a `success` generation is routinely an `engine_artifact`, an `environment_failure`
     * or a `client_bug` - a baseline built on it asserts the app behaved on evidence that says nothing about
     * the app. Resolving through `currentClassificationId` also keeps a self-heal from voting twice, since its
     * superseded iterations stay on disk as audit records.
     *
     * Keyed on `applicationId` because an app SLUG is not an identity - `Application` is unique on
     * `[slug, organizationId]`, so keying on the slug would let another tenant's passes establish
     * `everPassed`.
     */
    async getHistory({
        applicationId,
        testSlug,
        currentSnapshotId,
        before,
    }: PriorRunsQuery): Promise<PriorRunsHistory> {
        const scope = {
            testCase: { slug: testSlug, applicationId },
            reportSnapshotId: { not: currentSnapshotId },
            // A finding with no current classification was never judged - it is not a prior verdict.
            currentClassificationId: { not: null },
            createdAt: before != null ? { lt: before } : undefined,
        };
        const [findings, lastPass] = await Promise.all([
            this.db.analysisFinding.findMany({
                where: scope,
                select: { createdAt: true, currentClassification: { select: { category: true } } },
                orderBy: { createdAt: "desc" },
                take: MAX_RECENT_RUNS,
            }),
            this.db.analysisFinding.findFirst({
                where: { ...scope, currentClassification: { category: Category.enum.passed } },
                select: { createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
        ]);

        const recent: PriorRun[] = findings.flatMap((finding) =>
            finding.currentClassification == null
                ? []
                : [{ day: dayOf(finding.createdAt), category: finding.currentClassification.category }],
        );

        const passes = recent.filter((run) => run.category === Category.enum.passed);
        return {
            everPassed: lastPass != null,
            totalRecent: recent.length,
            passedCount: passes.length,
            mostRecentPassDay: lastPass != null ? dayOf(lastPass.createdAt) : undefined,
            recent,
        };
    }

    /** Render the baseline history as the prose the classifier's `prior_runs` tool returns to the model. */
    static formatBaseline(history: PriorRunsHistory): string {
        if (history.totalRecent === 0) {
            return "No prior runs of this test have ever been analyzed - it has NEVER been executed and judged before, so you cannot assume it was ever passing. Treat the test plan and scenario data as UNPROVEN: the failure may be a genesis-broken test/scenario, not this PR.";
        }
        const recent = history.recent
            .slice(0, RECENT_RUNS_TO_SHOW)
            .map((run) => `${run.day}:${run.category}`)
            .join(", ");
        const everPassed = describeEverPassed(history);
        return [
            `Prior runs (most recent ${history.totalRecent}), as the classifier judged them:`,
            `- ever passed: ${everPassed}`,
            `- recent: ${recent}`,
        ].join("\n");
    }
}

function dayOf(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/**
 * Three states, not two. A test that HAS passed but not inside the recent window is neither "valid, so blame
 * the change" nor "never worked, so do not" - it is a test whose last good run predates everything on show,
 * which is exactly when a regression is most likely to have been introduced somewhere in between and least
 * likely to be attributable to THIS PR.
 */
function describeEverPassed(history: PriorRunsHistory): string {
    if (!history.everPassed) {
        return "NO - no run of this test has ever been judged `passed`. Baseline NOT established: the test/scenario may be broken from genesis; do not assume this PR caused the failure. Read the verdicts below for WHY it never passed - a history of engine_artifact/environment_failure means the app was never actually exercised, while plan_mismatch/invalid_test means the test itself has never been right.";
    }
    if (history.passedCount > 0) {
        return `YES - judged \`passed\` on ${history.passedCount}/${history.totalRecent} of the recent runs; most recent pass on ${history.mostRecentPassDay}. Baseline established: the test+scenario were valid then, so a NEW failure is attributable to this change or a fresh env/scenario regression.`;
    }
    return `YES, but not recently - it last passed on ${history.mostRecentPassDay}, which is older than the ${history.totalRecent} runs listed below, so none of the runs shown here passed. The test+scenario DID work once, so this is not a genesis-broken test - but the regression may predate this PR by many runs. Attribute to this change only if the diff explains it; otherwise say the failure is longstanding.`;
}
