import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteStore } from "@autonoma/test-suite";
import type { StartInvestigationRunInput, StartInvestigationRunOutput } from "@autonoma/workflow/activities";

/**
 * Start one execution of a target test's pinned plan - the Investigator calls this immediately before provisioning,
 * so a scenario failure still has a run to hang its classification on. The only place the analysis pipeline creates
 * a run: suite edits never do, and the plan that runs is whatever the snapshot pins at this moment (after a
 * self-heal, the rewritten one).
 */
export async function startInvestigationRun(input: StartInvestigationRunInput): Promise<StartInvestigationRunOutput> {
    const { snapshotId, testCaseId } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "startInvestigationRun", extra: { testCaseId } });
    logger.info("Starting an investigation run");

    const store = new TestSuiteStore(db);
    const snapshot = await store.reopen(snapshotId);
    const { runId, scenarioId } = await snapshot.startRun(testCaseId);

    logger.info("Investigation run started", { extra: { testCaseId, runId, scenarioId } });
    return { runId, scenarioId };
}
