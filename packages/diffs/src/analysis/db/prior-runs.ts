import type { PrismaClient } from "@autonoma/db";

/** One historical run of a test, summarized for the classifier's baseline. */
export interface PriorRun {
    day: string;
    status: string;
    failureKind?: string;
}

/** The prior-run history for a test - the classifier's baseline ("has this ever passed?"). */
export interface PriorRunsHistory {
    /** Whether the test has ever succeeded in recorded history. */
    everPassed: boolean;
    /** Total recent runs considered (most recent first, capped). */
    totalRecent: number;
    /** How many of those recent runs succeeded. */
    successCount: number;
    /** Day (YYYY-MM-DD) of the most recent success, if any. */
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

    /** The recent run history for one test (by app + test slug), newest first. */
    async getHistory(appSlug: string, testSlug: string): Promise<PriorRunsHistory> {
        const runs = await this.db.run.findMany({
            where: { assignment: { testCase: { slug: testSlug, application: { slug: appSlug } } } },
            select: { status: true, createdAt: true, failure: true },
            orderBy: { createdAt: "desc" },
            take: MAX_RECENT_RUNS,
        });

        const recent: PriorRun[] = runs.map((run) => {
            const failureKind = failureKindOf(run.failure);
            const prior: PriorRun = { day: run.createdAt.toISOString().slice(0, 10), status: run.status };
            return failureKind != null ? { ...prior, failureKind } : prior;
        });

        const successes = recent.filter((run) => run.status === "success");
        const history: PriorRunsHistory = {
            everPassed: successes.length > 0,
            totalRecent: recent.length,
            successCount: successes.length,
            recent,
        };
        return successes[0] != null ? { ...history, mostRecentSuccessDay: successes[0].day } : history;
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
        const everPassed = history.everPassed
            ? `YES - passed ${history.successCount}/${history.totalRecent} of recent runs; most recent success on ${history.mostRecentSuccessDay}. Baseline established: the test+scenario were valid then, so a NEW failure is attributable to this change or a fresh env/scenario regression.`
            : "NO - it has never succeeded in recorded history. Baseline NOT established: the test/scenario may be broken from genesis; do not assume this PR caused the failure.";
        return [
            `Prior runs (most recent ${history.totalRecent}):`,
            `- ever passed: ${everPassed}`,
            `- recent: ${recent}`,
        ].join("\n");
    }
}
