import { logger as rootLogger } from "@autonoma/logger";
import type { InvestigationActivities } from "@autonoma/workflow/activities";
import { heartbeat } from "@temporalio/activity";
import { classifyInvestigationRun as classifyImpl } from "./classify-run";
import { selectInvestigationTests as selectImpl } from "./select-tests";
import { createValidationGeneration as createValidationImpl } from "./validate-proposal";
import { writeInvestigationReport as writeReportImpl } from "./write-report";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Wrap a long-running investigation activity so it heartbeats every 30s while it works. These activities
 * (clone + LLM select, the classify reasoning loop, report) run for MINUTES inside a single async call and
 * cannot heartbeat internally - so without this, Temporal's heartbeatTimeout (2m on these activities) kills
 * any run longer than two minutes, which is most classifies. `heartbeat()` throws outside an activity context
 * (e.g. the local pipeline runner), so we stop the timer on the first such failure - a no-op everywhere else.
 */
function withHeartbeat<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        const timer = setInterval(() => {
            try {
                heartbeat();
            } catch (error) {
                clearInterval(timer);
                rootLogger.debug("Not in a Temporal activity context; skipping heartbeats", { err: error });
            }
        }, HEARTBEAT_INTERVAL_MS);
        try {
            return await fn(...args);
        } finally {
            clearInterval(timer);
        }
    };
}

export const selectInvestigationTests = withHeartbeat(selectImpl);
export const classifyInvestigationRun = withHeartbeat(classifyImpl);
export const writeInvestigationReport = withHeartbeat(writeReportImpl);
export const createValidationGeneration = withHeartbeat(createValidationImpl);

/** Compile-time guarantee that the exported activities satisfy the workflow's activity contract. */
const _activities: InvestigationActivities = {
    selectInvestigationTests,
    classifyInvestigationRun,
    writeInvestigationReport,
    createValidationGeneration,
};
void _activities;
