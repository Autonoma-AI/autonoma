import { logger } from "@autonoma/logger";
import { DagBuilder } from "../../k8s/argo";
import { getK8sClient } from "../../k8s/k8s-client";
import { diffsTemplate } from "./diffs-template";

export interface TriggerDiffsJobParams {
    branchId: string;
}

export async function cancelDiffsJob(branchId: string): Promise<void> {
    const k8s = getK8sClient();
    const workflows = await k8s.queryWorkflows(`branch-id=${branchId}`);

    logger.info("Cancelling diffs workflows for branch", { branchId, count: workflows.length });

    for (const workflow of workflows) {
        const name = workflow.metadata?.name;
        if (name != null) {
            await k8s.deleteWorkflow(name);
        }
    }

    logger.info(`Cancelled ${workflows.length} jobs that were running while a new PR was received.`);
}

export async function triggerDiffsJob(params: TriggerDiffsJobParams): Promise<void> {
    const { branchId } = params;

    logger.info("Creating Argo workflow for diffs analysis", { branchId });

    const dag = new DagBuilder("main", {});
    const template = dag.addTemplate(await diffsTemplate());

    dag.addTask({
        name: "analyze",
        template,
        args: { branchId },
    });

    const k8s = getK8sClient();
    await k8s.createWorkflow({
        name: "diffs-analysis",
        labels: { "branch-id": branchId },
        dagData: dag.build(),
    });

    logger.info("Argo workflow for diffs analysis created successfully", { branchId });
}
