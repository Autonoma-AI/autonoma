import type { PrismaClient } from "@autonoma/db";

/** One historical run of a test, summarized for the classifier's baseline. */
export interface PriorRun {
    day: string;
    status: string;
    failureKind?: string;
}

/** The prior-run history for a test - the classifier's baseline ("has this ever passed?"). */
export interface PriorRunsHistory {
    /**
     * Whether the test has EVER succeeded, over its whole history rather than the recent window. Answered by
     * its own query: deriving it from the window meant a test that passed 31 runs ago was reported as never
     * having passed, and the prompt turns that into "do not blame the PR".
     */
    everPassed: boolean;
    /** Total recent runs considered (most recent first, capped). */
    totalRecent: number;
    /** How many of those recent runs succeeded. */
    successCount: number;
    /** Day (YYYY-MM-DD) of the most recent success, over the whole history - not just the recent window. */
    mostRecentSuccessDay?: string;
    /** The most recent runs, newest first. */
    recent: PriorRun[];
}

const MAX_RECENT_RUNS = 30;
const RECENT_RUNS_TO_SHOW = 10;

/** Pull a failure's discriminator out of the structured `Run.failure` JSON (kind / type / category), if present. */
function failureKindOf(failure: unknown): string | undefined {
    if (failure == null || typeof failure !== "object") return undefined;
    const record: Record<string, unknown> = { ...failure };
    for (const key of ["kind", "type", "category"]) {
        const value = record[key];
        if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
}

/** Reads + summarizes a test's run history (the classifier baseline). Replaces the prototype's raw psql join. */
export class PriorRuns {
    constructor(private readonly db: PrismaClient) {}

    /**
     * The recent run history for one test, newest first.
     *
     * Keyed on `applicationId`, which with the slug is `TestCase`'s own natural key
     * (`@@unique([applicationId, slug])`). An app SLUG is NOT an identity - `Application` is unique on
     * `[slug, organizationId]` - so slug-keying this silently merged the run history of every tenant sharing
     * an app slug, and `everPassed` could be established by another customer's passes. That decides whether
     * the classifier blames this PR, so the key has to be one that cannot span an organization.
     */
    async getHistory(applicationId: string, testSlug: string): Promise<PriorRunsHistory> {
        const scope = { assignment: { testCase: { slug: testSlug, applicationId } } };
        // "Has it EVER passed" is asked of the WHOLE history, not of the recent window: the window is a
        // display sample, and a test that last passed 31 runs ago is still a test that has passed.
        const [runs, lastSuccess] = await Promise.all([
            this.db.run.findMany({
                where: scope,
                select: { status: true, createdAt: true, failure: true },
                orderBy: { createdAt: "desc" },
                take: MAX_RECENT_RUNS,
            }),
            this.db.run.findFirst({
                where: { ...scope, status: "success" },
                select: { createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
        ]);

        const recent: PriorRun[] = runs.map((run) => {
            const failureKind = failureKindOf(run.failure);
            const prior: PriorRun = { day: run.createdAt.toISOString().slice(0, 10), status: run.status };
            return failureKind != null ? { ...prior, failureKind } : prior;
        });

        const successes = recent.filter((run) => run.status === "success");
        const history: PriorRunsHistory = {
            everPassed: lastSuccess != null,
            totalRecent: recent.length,
            successCount: successes.length,
            recent,
        };
        if (lastSuccess == null) return history;
        return { ...history, mostRecentSuccessDay: lastSuccess.createdAt.toISOString().slice(0, 10) };
    }

    /** Render the baseline history as the prose the classifier's `prior_runs` tool returns to the model. */
    static formatBaseline(history: PriorRunsHistory): string {
        if (history.totalRecent === 0) {
            return "No prior runs recorded for this test - it has NEVER been executed before, so you cannot assume it was ever passing. Treat the test plan and scenario data as UNPROVEN: the failure may be a genesis-broken test/scenario, not this PR.";
        }
        const recent = history.recent
            .slice(0, RECENT_RUNS_TO_SHOW)
            .map((run) => `${run.day}:${run.status}${run.failureKind != null ? `(${run.failureKind})` : ""}`)
            .join(", ");
        const everPassed = describeEverPassed(history);
        return [
            `Prior runs (most recent ${history.totalRecent}):`,
            `- ever passed: ${everPassed}`,
            `- recent: ${recent}`,
        ].join("\n");
    }
}

/**
 * The baseline sentence - the single line that decides whether the classifier may attribute this failure to
 * the PR at all.
 *
 * Three states, not two. A test that HAS passed but not inside the recent window is neither "valid, so blame
 * the change" nor "never worked, so do not" - it is a test whose last good run predates everything on show,
 * which is exactly when a regression is most likely to have been introduced somewhere in between and least
 * likely to be attributable to THIS PR. Collapsing that into either of the other two answers is what made the
 * old window-derived flag dangerous.
 */
function describeEverPassed(history: PriorRunsHistory): string {
    if (!history.everPassed) {
        return "NO - it has never succeeded in any recorded run. Baseline NOT established: the test/scenario may be broken from genesis; do not assume this PR caused the failure.";
    }
    if (history.successCount > 0) {
        return `YES - passed ${history.successCount}/${history.totalRecent} of the recent runs; most recent success on ${history.mostRecentSuccessDay}. Baseline established: the test+scenario were valid then, so a NEW failure is attributable to this change or a fresh env/scenario regression.`;
    }
    return `YES, but not recently - it last succeeded on ${history.mostRecentSuccessDay}, which is older than the ${history.totalRecent} runs listed below, so every run shown here failed. The test+scenario DID work once, so this is not a genesis-broken test - but the regression may predate this PR by many runs. Attribute to this change only if the diff explains it; otherwise say the failure is longstanding.`;
}
