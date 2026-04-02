import { logger } from "@autonoma/logger";
import { Architecture } from "@autonoma/types";
import { DagBuilder } from "../k8s/argo";
import { getK8sClient } from "../k8s/k8s-client";
import { replayReviewerTemplate } from "./replay-reviewer/replay-reviewer-template";
import { runReplayMobileTemplate } from "./replay/run-replay-mobile";
import { runReplayWebTemplate } from "./replay/run-replay-web";
import { runNotificationTemplate } from "./run-notification/run-notification.template";
import { scenarioDownTemplate } from "./scenario/scenario-down.template";
import { scenarioUpTemplate } from "./scenario/scenario-up.template";

export interface TriggerRunWorkflowParams {
    runId: string;
    architecture: Architecture;
    agentVersion: string;
    scenarioId?: string;
}

export async function triggerRunWorkflow({
    runId,
    architecture,
    agentVersion,
    scenarioId,
}: TriggerRunWorkflowParams): Promise<void> {
    logger.info("Building run replay workflow", { runId, architecture, agentVersion, scenarioId });

    const dag = new DagBuilder("main", {});
    const replayTemplate = dag.addTemplate(
        architecture === Architecture.web ? await runReplayWebTemplate() : await runReplayMobileTemplate(),
    );
    const reviewTemplate = dag.addTemplate(await replayReviewerTemplate());
    const notifyTemplate = dag.addTemplate(await runNotificationTemplate());

    if (scenarioId != null) {
        const [upTemplate, downTemplate] = await Promise.all([scenarioUpTemplate(), scenarioDownTemplate()]);
        const scenarioUp = dag.addTemplate(upTemplate);
        const scenarioDown = dag.addTemplate(downTemplate);

        const scenarioUpTask = dag.addTask({
            name: "scenario-up",
            template: scenarioUp,
            args: {
                scenarioJobType: "run",
                entityId: runId,
                scenarioId,
            },
        });

        const runReplayTask = dag.addTask({
            name: "run-replay",
            template: replayTemplate,
            args: { runId },
            depends: scenarioUpTask.succeeded,
        });

        dag.addTask({
            name: "scenario-down",
            template: scenarioDown,
            args: {
                scenarioInstanceId: scenarioUpTask.output("scenarioInstanceId"),
            },
            depends: runReplayTask.completed,
        });

        dag.addTask({
            name: "review-replay",
            template: reviewTemplate,
            args: { runId },
            depends: runReplayTask.completed,
        });

        dag.addTask({
            name: "notify-run-exit",
            template: notifyTemplate,
            args: { runId },
            depends: runReplayTask.completed,
        });
    } else {
        const runReplayTask = dag.addTask({
            name: "run-replay",
            template: replayTemplate,
            args: { runId },
        });

        dag.addTask({
            name: "review-replay",
            template: reviewTemplate,
            args: { runId },
            depends: runReplayTask.completed,
        });

        dag.addTask({
            name: "notify-run-exit",
            template: notifyTemplate,
            args: { runId },
            depends: runReplayTask.completed,
        });
    }

    const dagData = dag.build();
    const k8s = getK8sClient();

    logger.info("Creating Argo workflow for run replay", { runId });

    await k8s.createWorkflow({
        name: "run-replay",
        labels: {
            "run-id": runId,
            "agent-version": agentVersion,
        },
        dagData,
    });

    logger.info("Argo workflow for run replay created successfully", { runId });
}

export async function findLatestWorkflowByRunId(runId: string): Promise<{ name: string; uid: string } | undefined> {
    const k8s = getK8sClient();
    const items = await k8s.queryWorkflows(`run-id=${runId}`);

    const latest = items
        .filter((item) => item.metadata?.name != null && item.metadata?.uid != null)
        .sort((a, b) => {
            const aTime = Date.parse(a.metadata?.creationTimestamp ?? "");
            const bTime = Date.parse(b.metadata?.creationTimestamp ?? "");
            return bTime - aTime;
        })[0];

    if (latest?.metadata?.name == null || latest.metadata.uid == null) {
        return undefined;
    }

    return {
        name: latest.metadata.name,
        uid: latest.metadata.uid,
    };
}
