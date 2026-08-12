import type { PriorRunsHistory } from "@autonoma/analysis";

/** How many of the recent runs the baseline prose lists. */
const RECENT_RUNS_TO_SHOW = 10;

/** Render a test's prior-runs history as the prose the classifier's `prior_runs` tool returns. */
export function formatPriorRunsBaseline(history: PriorRunsHistory): string {
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
