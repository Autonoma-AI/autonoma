import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeDiffsInput, ReviewGenerationInput, ReviewReplayInput, ScenarioUpInput } from "../src/activities";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

// Mock the Temporal client used by triggers
vi.mock("../src/client", () => {
    const mockStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "batch-generation-test", firstExecutionRunId: "run-id-test" });
    const mockGetHandle = vi.fn().mockReturnValue({
        describe: vi.fn().mockResolvedValue({
            workflowId: "wf-1",
            runId: "run-1",
            status: { name: "COMPLETED" },
        }),
        cancel: vi.fn().mockResolvedValue({}),
        result: vi.fn().mockResolvedValue(undefined),
    });
    const mockList = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
            yield { workflowId: "wf-1", runId: "run-1" };
        },
    });

    return {
        getTemporalClient: vi.fn().mockResolvedValue({
            workflow: {
                start: mockStart,
                getHandle: mockGetHandle,
                list: mockList,
            },
        }),
        resetTemporalClient: vi.fn(),
    };
});

describe("trigger functions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("triggerBatchGeneration starts workflow with correct args", async () => {
        const { triggerBatchGeneration } = await import("../src/triggers/batch-generation");
        const { getTemporalClient } = await import("../src/client");

        await triggerBatchGeneration({
            snapshotId: "snap-1",
            testPlans: [{ testGenerationId: "tg-1", scenarioId: "sc-1" }, { testGenerationId: "tg-2" }],
            architecture: "WEB",
        });

        const client = await getTemporalClient();
        expect(client.workflow.start).toHaveBeenCalledOnce();

        const call = vi.mocked(client.workflow.start).mock.calls[0];
        expect(call).toBeDefined();
        // First arg is the workflow function
        // Rest is options
        const options = call?.[1];
        expect(options?.taskQueue).toBe("general");
        expect(options?.args?.[0]).toEqual({
            snapshotId: "snap-1",
            testPlans: [{ testGenerationId: "tg-1", scenarioId: "sc-1" }, { testGenerationId: "tg-2" }],
            architecture: "WEB",
        });
    });

    it("triggerRunWorkflow starts workflow with correct args", async () => {
        const { triggerRunWorkflow } = await import("../src/triggers/run-replay");
        const { getTemporalClient } = await import("../src/client");

        await triggerRunWorkflow({
            runId: "run-1",
            architecture: "web" as never,
            scenarioId: "sc-1",
        });

        const client = await getTemporalClient();
        expect(client.workflow.start).toHaveBeenCalledOnce();

        const call = vi.mocked(client.workflow.start).mock.calls[0];
        const options = call?.[1];
        expect(options?.taskQueue).toBe("general");
        expect(options?.args?.[0]).toMatchObject({
            runId: "run-1",
            scenarioId: "sc-1",
        });
    });

    it("triggerDiffsJob starts workflow with correct args", async () => {
        const { triggerDiffsJob } = await import("../src/triggers/diffs");
        const { getTemporalClient } = await import("../src/client");

        await triggerDiffsJob({ branchId: "branch-1", snapshotId: "snap-1" });

        const client = await getTemporalClient();
        expect(client.workflow.start).toHaveBeenCalledOnce();

        const call = vi.mocked(client.workflow.start).mock.calls[0];
        const options = call?.[1];
        expect(options?.workflowId).toBe("diffs-analysis-snap-1");
        expect(options?.taskQueue).toBe("diffs");
        expect(options?.args?.[0]).toEqual({ snapshotId: "snap-1" });
    });

    it("findLatestWorkflowByGenerationId returns workflow ref", async () => {
        const { findLatestWorkflowByGenerationId } = await import("../src/triggers/batch-generation");

        const result = await findLatestWorkflowByGenerationId("gen-1");

        expect(result).toEqual({ workflowId: "wf-1", runId: "run-1" });
    });

    it("findLatestWorkflowByRunId returns workflow ref", async () => {
        const { findLatestWorkflowByRunId } = await import("../src/triggers/run-replay");

        const result = await findLatestWorkflowByRunId("run-1");

        expect(result).toEqual({ workflowId: "wf-1", runId: "run-1" });
    });

    it("triggerPreviewDeploy waits for graceful supersede cleanup before starting replacement", async () => {
        const { triggerPreviewDeploy } = await import("../src/triggers/previewkit");
        const { getTemporalClient } = await import("../src/client");
        const client = await getTemporalClient();
        const cancelled = deferred<void>();
        const inFlightHandle = {
            describe: vi.fn().mockResolvedValue({ status: { name: "RUNNING" } }),
            cancel: vi.fn().mockResolvedValue({}),
            result: vi.fn().mockReturnValue(
                cancelled.promise.then(() => {
                    throw new Error("workflow cancelled");
                }),
            ),
        };
        vi.mocked(client.workflow.getHandle).mockReturnValueOnce(inFlightHandle as never);

        const pending = triggerPreviewDeploy({
            event: {
                action: "synchronize",
                prNumber: 7,
                repoFullName: "acme/web",
                organizationId: "org_1",
                githubRepositoryId: 123,
                headSha: "abc1234def5678",
                headRef: "feature/login",
                baseSha: "",
                baseRef: "",
                cloneUrl: "https://github.com/acme/web.git",
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(inFlightHandle.cancel).toHaveBeenCalledOnce();
        expect(client.workflow.start).not.toHaveBeenCalled();

        cancelled.resolve();
        await pending;

        expect(client.workflow.start).toHaveBeenCalledOnce();
        const options = vi.mocked(client.workflow.start).mock.calls[0]?.[1];
        expect(options?.workflowId).toBe("previewkit-acme-web-7");
        expect(options?.workflowIdConflictPolicy).toBe(WorkflowIdConflictPolicy.TERMINATE_EXISTING);
    });
});

describe("activity contracts", () => {
    it("general activities have correct input shapes", async () => {
        const env = new MockActivityEnvironment();

        // Verify activity function shapes match expectations
        const reviewGenInput: ReviewGenerationInput = { generationId: "gen-1" };
        const reviewReplayInput: ReviewReplayInput = { runId: "run-1" };
        const scenarioUpInput: ScenarioUpInput = { scenarioJobType: "generation", entityId: "e-1", scenarioId: "s-1" };
        const analyzeDiffsInput: AnalyzeDiffsInput = { branchId: "branch-1" };

        // Validate types compile correctly
        expect(reviewGenInput.generationId).toBe("gen-1");
        expect(reviewReplayInput.runId).toBe("run-1");
        expect(scenarioUpInput.scenarioJobType).toBe("generation");
        expect(analyzeDiffsInput.branchId).toBe("branch-1");

        await env.cancel();
    });
});

describe("task queues", () => {
    it("exports correct queue names", async () => {
        const { TaskQueue } = await import("../src/task-queues");

        expect(TaskQueue.WEB).toBe("web");
        expect(TaskQueue.MOBILE).toBe("mobile");
        expect(TaskQueue.GENERAL).toBe("general");
    });
});
