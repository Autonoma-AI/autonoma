import { DagBuilder } from "../../k8s/argo";
import type { ArgoTemplateData } from "../../k8s/argo/templates/template";
import { generationReviewerTemplate } from "../generation-reviewer/generation-reviewer-template";
import { scenarioDownTemplate } from "../scenario/scenario-down.template";
import { scenarioUpTemplate } from "../scenario/scenario-up.template";
import { billingNotifyTemplate } from "./billing-notify.template";
import { markGenerationFailedTemplate } from "./mark-generation-failed.template";
import { executionAgentMobileTemplate } from "./mobile/execution-agent-mobile";
import { executionAgentWebTemplate } from "./web/execution-agent-web";

export type WorkflowArchitecture = "WEB" | "IOS" | "ANDROID";

export interface TestPlanItem {
    testGenerationId: string;
    scenarioId?: string;
}

export type ExecutionTemplate = ArgoTemplateData<{ testGenerationId: string }>;

const GENERATION_DAG_INPUTS = {
    testGenerationId: "test-generation-id",
    scenarioId: "scenario-id",
} as const;

export async function resolveExecutionTemplate(architecture: WorkflowArchitecture): Promise<ExecutionTemplate> {
    return architecture === "WEB" ? executionAgentWebTemplate() : executionAgentMobileTemplate();
}

export async function buildGenerationDag(executionTemplate: ExecutionTemplate) {
    const dag = new DagBuilder("test-generation-workflow", GENERATION_DAG_INPUTS);

    const [upTemplate, downTemplate, notifyTemplate, reviewTemplate, markFailedTpl] = await Promise.all([
        scenarioUpTemplate(),
        scenarioDownTemplate(),
        billingNotifyTemplate(),
        generationReviewerTemplate(),
        markGenerationFailedTemplate(),
    ]);

    const runExecution = dag.addTemplate(executionTemplate);
    const scenarioUp = dag.addTemplate(upTemplate);
    const scenarioDown = dag.addTemplate(downTemplate);
    const notifyGenerationExit = dag.addTemplate(notifyTemplate);
    const reviewGeneration = dag.addTemplate(reviewTemplate);
    const markFailed = dag.addTemplate(markFailedTpl);

    const scenarioUpTask = dag.addTask({
        name: "scenario-up",
        template: scenarioUp,
        args: {
            scenarioJobType: "generation",
            entityId: dag.input("testGenerationId"),
            scenarioId: dag.input("scenarioId"),
        },
        when: `'${dag.input("scenarioId")}' != ''`,
    });

    const runGeneration = dag.addTask({
        name: "run-generation",
        template: runExecution,
        args: { testGenerationId: dag.input("testGenerationId") },
        depends: `${scenarioUpTask.succeeded} || ${scenarioUpTask.skipped}`,
    });

    dag.addTask({
        name: "notify-generation-exit",
        template: notifyGenerationExit,
        args: { testGenerationId: dag.input("testGenerationId") },
        depends: runGeneration.completed,
    });

    dag.addTask({
        name: "scenario-down",
        template: scenarioDown,
        args: {
            scenarioInstanceId: scenarioUpTask.output("scenarioInstanceId"),
        },
        depends: runGeneration.completed,
        when: `'${dag.input("scenarioId")}' != ''`,
    });

    dag.addTask({
        name: "review-generation",
        template: reviewGeneration,
        args: { generationId: dag.input("testGenerationId") },
        depends: runGeneration.completed,
    });

    // Failure path: when scenario-up fails, mark the generation as failed
    // so it doesn't stay stuck in "queued" forever.
    const markGenerationFailed = dag.addTask({
        name: "mark-generation-failed",
        template: markFailed,
        args: { testGenerationId: dag.input("testGenerationId") },
        depends: scenarioUpTask.failed,
    });

    dag.addTask({
        name: "notify-generation-exit-on-failure",
        template: notifyGenerationExit,
        args: { testGenerationId: dag.input("testGenerationId") },
        depends: markGenerationFailed.completed,
    });

    return dag.build();
}
