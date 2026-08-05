import type { ObservabilityContext } from "@autonoma/logger";
import { log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisActivities, RunImpactAnalysisOutput } from "../activities";
import { TaskQueue } from "../task-queues";
import { runInvestigators } from "./run-investigators";

const analysis = proxyActivities<Pick<AnalysisActivities, "runReporter">>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

/**
 * An empty selection is a no-op fan-out, not a special case: a run that selected nothing still reports and
 * settles like any other.
 */
export async function runAnalysisStages(
    snapshotId: string,
    impact: RunImpactAnalysisOutput,
    ids: ObservabilityContext,
): Promise<void> {
    const candidates = await runInvestigators(snapshotId, impact.targets);
    log.info("Investigators complete", { ...ids, extra: { candidateCount: candidates.length } });

    const reporter = await analysis.runReporter({ snapshotId, impactReasoning: impact.reasoning });
    log.info("Reporter complete", {
        ...ids,
        extra: {
            verdict: reporter.verdict,
            clientBugCount: reporter.clientBugCount,
            issuesOpened: reporter.issuesOpened,
            issuesCarried: reporter.issuesCarried,
            issuesResolved: reporter.issuesResolved,
        },
    });
}
