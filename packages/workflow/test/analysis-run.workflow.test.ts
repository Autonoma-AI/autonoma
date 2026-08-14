import { type AnalysisRunOutcome, CANCELLED_RUN_REASON, type PreviewDeployTarget } from "@autonoma/types";
import { Context } from "@temporalio/activity";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    AnalysisActivities,
    AnalysisInvestigationTarget,
    ClassifyInvestigationRunInput,
    InvestigationTestResult,
    LaunchPreviewBuildInput,
    OpenAnalysisSkipReason,
    PreviewBuildWarrantReason,
    PreviewkitActivities,
    ReadPreviewBuildStatusOutput,
    ReportPreviewBuildWarrantInput,
} from "../src/activities";
import { previewBuildWorkflowId } from "../src/preview-build-id";
import { warrantsBuild } from "../src/rules/build-warrant";
import { TaskQueue } from "../src/task-queues";
import { analysisRunWorkflow } from "../src/workflows/analysis-run.workflow";
import { teardownTestWorkflowEnvironment } from "./fixtures/teardown-test-workflow-environment";
import { terminateAbandonedExecutions } from "./fixtures/terminate-abandoned-executions";
import { createTimeSkippingTestEnvironment } from "./fixtures/test-workflow-environment";
import { workflowBundle } from "./fixtures/workflow-bundle";

/**
 * The REAL run in the time-skipping environment with mocked activities, so every assertion is on an observable
 * outcome - whether a build was scheduled at all, its order against impact analysis, how the run settled.
 */

const ORGANIZATION_ID = "org-1";
const REPO = "acme/widgets";
const HEAD_SHA = "head000";
const SNAPSHOT_ID = "snap-1";
const PREVIEW_URL = "https://web-pr-7.preview.example.com";
const SLUG = "checkout-flow";

/** How long an activity waits for a concurrently-scheduled sibling before declaring the flow serial. */
const CONCURRENCY_WAIT_MS = 10_000;

/** A mutable per-test script the mocked activities read. */
interface Harness {
    previewTarget?: PreviewDeployTarget;
    everBuilt: boolean;
    /** Whether the branch already has a deployment. Only read when there is no `previewTarget`. */
    hasRecordedPreview: boolean;
    /** Every existing case is an onboarded app; the deadlock case flips it. */
    onboardingComplete: boolean;
    targets: AnalysisInvestigationTarget[];
    impactError?: Error;
    snapshotSkipped: boolean;
    snapshotSkipReason: OpenAnalysisSkipReason;
    snapshotError?: Error;
    /** Blocks impact analysis until the build launches, so a serial flow deadlocks rather than passing. */
    impactWaitsForBuild: boolean;
    /** Blocks impact analysis until cancelled - the hook for interrupting mid-flow. */
    impactBlocksUntilCancelled: boolean;

    buildLaunches: LaunchPreviewBuildInput[];
    buildStatus: ReadPreviewBuildStatusOutput;
    cancelledJobs: string[];
    gateReports: ReportPreviewBuildWarrantInput[];
    settlements: AnalysisRunOutcome[];
    reporterRuns: number;
    /** Snapshot ids passed to `attachPreviewDeployment` - proof a URL lands only once the preview is live. */
    attachedUrls: string[];
    webRuns: string[];
    events: string[];

    /**
     * Resolves when the build's launch activity has actually run. A run that skips analysis returns without
     * awaiting its build child, so the parent completing says nothing about whether `build:launch` was recorded
     * yet - assert on `events` only after this settles.
     */
    buildLaunched: Promise<void>;
    notifyBuildLaunched: () => void;
    impactStarted: Promise<void>;
    notifyImpactStarted: () => void;
}

const harness: Harness = {
    everBuilt: false,
    hasRecordedPreview: true,
    onboardingComplete: true,
    targets: [],
    snapshotSkipped: false,
    snapshotSkipReason: "already_analyzed",
    impactWaitsForBuild: false,
    impactBlocksUntilCancelled: false,
    buildLaunches: [],
    buildStatus: { state: "ready", primaryUrl: PREVIEW_URL },
    cancelledJobs: [],
    gateReports: [],
    settlements: [],
    reporterRuns: 0,
    attachedUrls: [],
    webRuns: [],
    events: [],
    buildLaunched: Promise.resolve(),
    notifyBuildLaunched: () => undefined,
    impactStarted: Promise.resolve(),
    notifyImpactStarted: () => undefined,
};

/** Monotonic counter for unique workflow ids and snapshot ids across executions. */
let executionCounter = 0;
/** The build workflow id the run under test would use, so a test can ask whether a build was started at all. */
let currentBuildId = "";

/**
 * Every execution the current test started - the run AND the preview build it may spawn - so anything it abandons is
 * stopped before the next test runs. The child is registered as well as the parent because it is started with
 * `ParentClosePolicy.REQUEST_CANCEL`: closing the run only *asks* the build to stop, so a build that has already
 * launched keeps running, and its mocked activities keep appending to the shared `harness` the next test reads.
 */
let startedWorkflowIds: string[] = [];

/**
 * Asked of the WORKFLOW, not the launch activity: `startChild` resolves once the child has started, so the child
 * either exists by then or never will. The activity it then runs is scheduled asynchronously and would race.
 */
async function buildWasStarted(): Promise<boolean> {
    try {
        await env.client.workflow.getHandle(currentBuildId).describe();
        return true;
    } catch {
        return false;
    }
}

/**
 * The build child's terminal status, so a test can tell a build that RAN from one that was merely
 * STARTED. `buildWasStarted` cannot: the child exists either way, and a cancelled one is the failure.
 */
async function buildStatusName(): Promise<string | undefined> {
    try {
        const description = await env.client.workflow.getHandle(currentBuildId).describe();
        return description.status.name;
    } catch {
        return undefined;
    }
}

/** Only skips: a build reports its own reason from inside the child, asynchronously, and would race. */
function skipReports(): PreviewBuildWarrantReason[] {
    return harness.gateReports.map((report) => report.reason).filter((reason) => !warrantsBuild(reason));
}

function target(): AnalysisInvestigationTarget {
    return {
        slug: SLUG,
        testCaseId: "tc-checkout",
        reason: "the diff touched checkout",
        origin: "pre_existing",
    };
}

function deployEvent(overrides: Partial<PreviewDeployTarget> = {}): PreviewDeployTarget {
    return {
        prNumber: 7,
        repoFullName: REPO,
        organizationId: ORGANIZATION_ID,
        githubRepositoryId: 99,
        headSha: HEAD_SHA,
        headRef: "feature/checkout",
        branchId: "branch-1",
        ...overrides,
    };
}

/**
 * Rejects if a concurrently-scheduled sibling never arrives, so a regression that makes the flow serial fails with
 * a clear message instead of hanging until the suite's own timeout.
 */
function requireConcurrent(signal: Promise<void>): Promise<void> {
    return Promise.race([
        signal,
        new Promise<never>((_resolve, reject) => {
            setTimeout(
                () => reject(new Error("the build was not launched concurrently with impact analysis")),
                CONCURRENCY_WAIT_MS,
            ).unref();
        }),
    ]);
}

/** Blocks an activity until the workflow cancels it, so a test can interrupt the flow mid-analysis. */
function untilCancelled(): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        Context.current().cancellationSignal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
        });
    });
}

const analysisActivities: Pick<
    AnalysisActivities,
    "openAnalysisRun" | "openMergeGate" | "runImpactAnalysis" | "runReporter" | "settleAnalysisRun"
> = {
    async openAnalysisRun() {
        harness.events.push("snapshot");
        if (harness.snapshotError != null) throw harness.snapshotError;
        if (harness.snapshotSkipped) return { skipped: true, reason: harness.snapshotSkipReason };
        return { skipped: false, snapshotId: SNAPSHOT_ID };
    },
    async openMergeGate() {
        return { status: "skipped" };
    },
    async runImpactAnalysis() {
        harness.events.push("impact:start");
        harness.notifyImpactStarted();
        if (harness.impactError != null) throw harness.impactError;
        if (harness.impactBlocksUntilCancelled) await untilCancelled();
        if (harness.impactWaitsForBuild) await requireConcurrent(harness.buildLaunched);
        harness.events.push("impact:end");
        return { targets: harness.targets, reasoning: "scripted" };
    },
    async runReporter() {
        harness.reporterRuns += 1;
        harness.events.push("reporter");
        return {
            persisted: true,
            issuesOpened: 0,
            issuesCarried: 0,
            issuesResolved: 0,
            verdict: "passed",
            clientBugCount: 0,
        };
    },
    async settleAnalysisRun(input) {
        harness.settlements.push(input.outcome);
        harness.events.push(`settle:${input.outcome.kind}`);
        return { settled: true, discardedChangeCount: 0 };
    },
};

const previewkitActivities: PreviewkitActivities = {
    async resolvePreviewTarget() {
        const target = harness.previewTarget;
        return target != null
            ? {
                  organizationId: target.organizationId,
                  target,
                  hasRecordedPreview: harness.hasRecordedPreview,
                  onboardingComplete: harness.onboardingComplete,
              }
            : {
                  organizationId: ORGANIZATION_ID,
                  hasRecordedPreview: harness.hasRecordedPreview,
                  onboardingComplete: harness.onboardingComplete,
              };
    },
    async hasBranchEverBuiltPreview() {
        return { everBuilt: harness.everBuilt };
    },
    async launchPreviewBuild(input) {
        harness.buildLaunches.push(input);
        harness.events.push("build:launch");
        harness.notifyBuildLaunched();
        return { jobName: `pk-deploy-${harness.buildLaunches.length}` };
    },
    async cancelPreviewBuild(input) {
        harness.cancelledJobs.push(input.jobName);
        harness.events.push("build:cancel");
        return Promise.resolve();
    },
    async readPreviewBuildJobState() {
        return { state: "running" };
    },
    async readPreviewBuildStatus() {
        return harness.buildStatus;
    },
    async attachPreviewDeployment(input) {
        harness.attachedUrls.push(input.url);
        harness.events.push("attach");
        return { deploymentId: "deployment-1" };
    },
    async reportPreviewBuildWarrant(input) {
        harness.gateReports.push(input);
        return Promise.resolve();
    },
};

// The Investigator child runs for real when the gate lets a build through, so the test scripts its two activities to
// a clean `passed` verdict. `webRuns` is then the observable proof that the fan-out happened.
const investigatorActivities = {
    // The Investigator starts its own runs; the id it gets back is what lands on the web queue.
    startInvestigationRun() {
        return Promise.resolve({ runId: "gen-1" });
    },
    async classifyInvestigationRun(_input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult> {
        return {
            slug: SLUG,
            plan: "1. Open checkout.",
            runSuccess: true,
            stepCount: 2,
            verdict: {
                category: "passed",
                isClientBug: false,
                ran: true,
                confidence: "high",
                headline: "checkout works",
                falsePositiveRisk: "none",
                whatHappened: "n/a",
                rootCause: "n/a",
                remediation: "n/a",
                evidence: [{ source: "run", detail: "n/a" }],
            },
        };
    },
    persistAnalysisClassification() {
        return Promise.resolve({ findingId: "finding-1", number: 1 });
    },
};

const webActivities = {
    runWebGeneration(input: { testGenerationId: string }): Promise<void> {
        harness.webRuns.push(input.testGenerationId);
        harness.events.push("investigator:run");
        return Promise.resolve();
    },
};

let env: TestWorkflowEnvironment;
let workers: Worker[];
let runner: Promise<unknown>;

beforeAll(async () => {
    env = await createTimeSkippingTestEnvironment();
    // One worker per queue, matching production - which is also what makes a stage proxied to the wrong queue
    // fail here rather than in the cluster.
    const diffsWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.DIFFS,
        workflowBundle: workflowBundle(),
        activities: { ...analysisActivities, ...investigatorActivities },
    });
    // Needs the bundle too: the preview build is a WORKFLOW on this queue.
    const generalWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.GENERAL,
        workflowBundle: workflowBundle(),
        activities: previewkitActivities,
    });
    const webWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.WEB,
        activities: webActivities,
    });
    workers = [diffsWorker, generalWorker, webWorker];
    runner = Promise.all(workers.map((worker) => worker.run()));
});

afterAll(async () => {
    await teardownTestWorkflowEnvironment({ env, workers, runner });
});

beforeEach(() => {
    harness.previewTarget = undefined;
    harness.everBuilt = false;
    harness.hasRecordedPreview = true;
    harness.onboardingComplete = true;
    harness.targets = [];
    harness.impactError = undefined;
    harness.snapshotSkipped = false;
    harness.snapshotSkipReason = "already_analyzed";
    harness.snapshotError = undefined;
    harness.impactWaitsForBuild = false;
    harness.impactBlocksUntilCancelled = false;
    harness.buildLaunches = [];
    harness.buildStatus = { state: "ready", primaryUrl: PREVIEW_URL };
    harness.cancelledJobs = [];
    harness.gateReports = [];
    harness.settlements = [];
    harness.reporterRuns = 0;
    harness.attachedUrls = [];
    harness.webRuns = [];
    harness.events = [];
    harness.buildLaunched = new Promise((resolve) => {
        harness.notifyBuildLaunched = resolve;
    });
    harness.impactStarted = new Promise((resolve) => {
        harness.notifyImpactStarted = resolve;
    });
});

afterEach(async () => {
    await terminateAbandonedExecutions(env, startedWorkflowIds);
    startedWorkflowIds = [];
});

/** Names this execution's workflow and registers it for the sweep, so an id cannot be minted without being tracked. */
function trackedWorkflowId(prefix: string): string {
    const workflowId = `${prefix}-${executionCounter}`;
    startedWorkflowIds.push(workflowId);
    return workflowId;
}

function startRun(target: PreviewDeployTarget = deployEvent()) {
    executionCounter += 1;
    // Own commit and own repo per execution, because the build workflow is keyed per commit: without this, a second
    // execution would collide with the first one's build id rather than starting its own.
    const scoped: PreviewDeployTarget = {
        ...target,
        repoFullName: `${target.repoFullName}-${executionCounter}`,
        headSha: `${target.headSha}-${executionCounter}`,
    };
    currentBuildId = previewBuildWorkflowId(scoped);
    // Not allocated by us, but ours to stop: the run may leave this child behind.
    startedWorkflowIds.push(currentBuildId);
    harness.previewTarget = scoped;
    return env.client.workflow.start(analysisRunWorkflow, {
        // Matches production: the run orchestrates on `general` and proxies its cloning stages to `diffs`.
        taskQueue: TaskQueue.GENERAL,
        workflowId: trackedWorkflowId("previewkit-run-test"),
        args: [
            {
                branchId: scoped.branchId ?? "branch-1",
                headSha: scoped.headSha,
            },
        ],
    });
}

async function runToCompletion(target: PreviewDeployTarget = deployEvent()): Promise<void> {
    const handle = await startRun(target);
    await handle.result();
}

describe("analysisRunWorkflow build gate", () => {
    it("skips the build when a never-previewed branch's diff selects no tests", async () => {
        await runToCompletion();

        expect(await buildWasStarted()).toBe(false);
        expect(harness.attachedUrls).toEqual([]);
        expect(harness.reporterRuns).toBe(1);
        expect(harness.settlements).toEqual([{ kind: "succeeded" }]);
        expect(skipReports()).toEqual(["no_test_work"]);
    });

    // The deadlock #1937 created: onboarding needs a preview to implement the SDK handler, the
    // handler produces the suite, and the suite is what a selection could be about. Judging the
    // commit on an empty selection refused the build that was the only way out.
    it("builds without analysing while the app is still onboarding", async () => {
        harness.onboardingComplete = false;

        await runToCompletion();

        expect(await buildWasStarted()).toBe(true);
        await harness.buildLaunched;
        // The build and nothing else: no snapshot, no selection, no stages, because there is
        // nothing for them to be about yet.
        expect(harness.events).toEqual(["build:launch"]);
        expect(harness.reporterRuns).toBe(0);
    });

    // The base preview is what onboarding configures first, and it must keep building while the
    // app is mid-onboarding - it is exempt for its own reason (no pull request to judge), and the
    // eager build runs before the analysis is skipped rather than instead of it.
    it("still builds the main-branch environment while the app is onboarding", async () => {
        harness.onboardingComplete = false;

        // Through `runToCompletion`, not by assigning `harness.previewTarget`: `startRun` scopes and overwrites
        // that field per execution, so a target set beforehand never reaches the workflow.
        await runToCompletion(deployEvent({ prNumber: 0 }));

        expect(await buildWasStarted()).toBe(true);
        await harness.buildLaunched;
        expect(harness.events).toEqual(["build:launch"]);
    });

    // The build is a child started with REQUEST_CANCEL, so a run that returns while it is in flight
    // cancels the build it just started. Onboarding is the only path that returns with one running,
    // which makes it the only path where "started" and "ran" can come apart - and the base preview is
    // precisely what the customer is waiting on at that moment.
    it("lets the onboarding build finish instead of cancelling it on the way out", async () => {
        harness.onboardingComplete = false;

        await runToCompletion(deployEvent({ prNumber: 0 }));

        expect(await buildStatusName()).toBe("COMPLETED");
        expect(harness.cancelledJobs).toEqual([]);
    });

    it("builds and then investigates when a never-previewed branch's diff selects a test", async () => {
        harness.targets = [target()];

        await runToCompletion();

        expect(await buildWasStarted()).toBe(true);
        expect(harness.attachedUrls).toEqual([PREVIEW_URL]);
        expect(harness.webRuns).toEqual(["gen-1"]);
        expect(harness.settlements).toEqual([{ kind: "succeeded" }]);
        // The build is decided AFTER the selection, and the Investigators only run once its URL is recorded.
        expect(harness.events).toEqual([
            "snapshot",
            "impact:start",
            "impact:end",
            "build:launch",
            "attach",
            "investigator:run",
            "reporter",
            "settle:succeeded",
        ]);
    });

    it("launches the build without waiting for impact analysis once the branch has a preview", async () => {
        harness.everBuilt = true;
        harness.impactWaitsForBuild = true;

        await runToCompletion();

        expect(await buildWasStarted()).toBe(true);
        // The build leads the whole run: it is under way before impact analysis finishes, which is what keeps an
        // established preview refreshing as fast as it did before any gate existed.
        expect(harness.events.indexOf("build:launch")).toBeLessThan(harness.events.indexOf("impact:end"));
        expect(harness.settlements).toEqual([{ kind: "succeeded" }]);
    });

    /**
     * The invariant an established preview rests on: analysis informs the build but can never deny it. A pipeline
     * that dies before it starts - a Temporal blip, one transient DB error on the un-retried snapshot activity -
     * must still leave the customer with the refresh they are entitled to.
     */
    it("still builds for a branch with a preview when the pipeline fails before it starts", async () => {
        harness.everBuilt = true;
        harness.snapshotError = new Error("snapshot creation exploded");

        const handle = await startRun();
        await expect(handle.result()).rejects.toThrow("Workflow execution failed");

        // Started before the run was opened, so the failure that follows cannot deny it.
        expect(await buildWasStarted()).toBe(true);
    });

    // The mirror image: on a never-previewed branch the gate is entitled to deny, so the same failure builds nothing.
    it("builds nothing for a never-previewed branch when the pipeline fails before it starts", async () => {
        harness.snapshotError = new Error("snapshot creation exploded");

        const handle = await startRun();
        await expect(handle.result()).rejects.toThrow("Workflow execution failed");

        expect(await buildWasStarted()).toBe(false);
    });

    // Main is not a different KIND of run - the gate simply cannot apply to it, as with an already-previewed
    // branch. It builds eagerly and then analyses like anything else.
    it("always builds the main-branch preview, and still runs the analysis", async () => {
        harness.impactWaitsForBuild = true;

        await runToCompletion(deployEvent({ prNumber: 0, branchId: "branch-main" }));

        expect(await buildWasStarted()).toBe(true);
        expect(harness.reporterRuns).toBe(1);
        expect(harness.settlements).toEqual([{ kind: "succeeded" }]);
    });

    /**
     * Every environment-0 trigger lands here: its base sha IS its head sha, so the run is always skipped, while the
     * main-branch warrant is unconditional. Returning without the child would have `REQUEST_CANCEL` kill the build
     * the warrant just promised - and the environment row is written late enough that no preview survives it.
     */
    it("waits for the eager build rather than cancelling it when the run is skipped", async () => {
        harness.snapshotSkipped = true;

        await runToCompletion(deployEvent({ prNumber: 0, branchId: "branch-main" }));

        const build = await env.client.workflow.getHandle(currentBuildId).describe();
        expect(build.status.name).toBe("COMPLETED");
    });

    /** The restart path starts its own child, so it owes it the same wait the eager one does. */
    it("waits for a restarted build rather than cancelling it", async () => {
        harness.snapshotSkipped = true;
        harness.buildStatus = { state: "ready", primaryUrl: PREVIEW_URL };

        await runToCompletion();

        const build = await env.client.workflow.getHandle(currentBuildId).describe();
        expect(build.status.name).toBe("COMPLETED");
    });

    it("rebuilds an already-analyzed head whose earlier build was attempted and lost", async () => {
        harness.snapshotSkipped = true;
        harness.buildStatus = { state: "superseded" };

        await runToCompletion();

        expect(await buildWasStarted()).toBe(true);
        expect(harness.settlements).toEqual([]);
    });

    // A commit the gate refused leaves no build record, so a second trigger for that head must honour the
    // earlier verdict rather than build "just in case".
    it("does not rebuild an already-analyzed head the gate previously refused", async () => {
        harness.snapshotSkipped = true;
        harness.buildStatus = { state: "missing" };

        await runToCompletion();

        expect(await buildWasStarted()).toBe(false);
        expect(harness.settlements).toEqual([]);
        expect(skipReports()).toEqual(["no_test_work"]);
    });

    // An application no run can reach a verdict on has no earlier verdict to honour, so the already-judged rebuild
    // path must not run for it - `buildStatus: superseded` would otherwise rebuild.
    it("does not rebuild when the application can produce no test work", async () => {
        harness.snapshotSkipped = true;
        harness.snapshotSkipReason = "no_test_folders";
        harness.buildStatus = { state: "superseded" };

        await runToCompletion();

        expect(await buildWasStarted()).toBe(false);
        expect(harness.settlements).toEqual([]);
    });

    // Being untestable must not cost the customer the refresh they are entitled to: the eager build is a child with
    // REQUEST_CANCEL, so returning without it would kill the build the warrant already promised.
    it("waits for the eager build when the application can produce no test work", async () => {
        harness.everBuilt = true;
        harness.snapshotSkipped = true;
        harness.snapshotSkipReason = "no_test_folders";

        await runToCompletion();

        const build = await env.client.workflow.getHandle(currentBuildId).describe();
        expect(build.status.name).toBe("COMPLETED");
        expect(harness.settlements).toEqual([]);
    });

    // A build that never comes up must fail the run: Investigators with no environment report engine artifacts.
    it("fails the run when the build settles without a live preview", async () => {
        harness.targets = [target()];
        harness.buildStatus = { state: "failed", error: "image build exploded" };

        const handle = await startRun();
        await expect(handle.result()).rejects.toThrow("Workflow execution failed");

        expect(harness.attachedUrls).toEqual([]);
        expect(harness.webRuns).toEqual([]);
        expect(harness.settlements).toEqual([{ kind: "failed", reason: expect.stringContaining("failed") }]);
    });

    it("skips the build and settles as failed when the gate cannot be decided", async () => {
        harness.impactError = new Error("impact exploded");

        const handle = await startRun();
        await expect(handle.result()).rejects.toThrow("Workflow execution failed");

        expect(await buildWasStarted()).toBe(false);
        expect(harness.reporterRuns).toBe(0);
        expect(harness.settlements).toEqual([{ kind: "failed", reason: "impact exploded" }]);
        expect(skipReports()).toEqual(["analysis_indeterminate"]);
    });

    it("settles the run as cancelled when the flow is cancelled mid-analysis", async () => {
        harness.impactBlocksUntilCancelled = true;

        const handle = await startRun();
        await harness.impactStarted;
        await handle.cancel();

        await expect(handle.result()).rejects.toThrow("Workflow execution cancelled");
        expect(harness.settlements).toEqual([{ kind: "cancelled", reason: CANCELLED_RUN_REASON }]);
    });
});

describe("analysisRunWorkflow on a customer-deployed branch", () => {
    it("opens no snapshot when the customer's preview is not recorded yet", async () => {
        harness.hasRecordedPreview = false;
        harness.targets = [target()];

        await startCustomerDeployedRun();

        // No snapshot is the whole point: one would take this head as analyzed, and the customer's own trigger -
        // the only thing that can record their preview - would then be dropped as a duplicate.
        expect(harness.events).toEqual([]);
        expect(harness.settlements).toEqual([]);
        expect(harness.webRuns).toEqual([]);
    });

    it("analyzes against the recorded preview, building nothing", async () => {
        harness.targets = [target()];

        await startCustomerDeployedRun();

        expect(await buildWasStarted()).toBe(false);
        expect(harness.attachedUrls).toEqual([]);
        expect(harness.webRuns).toEqual(["gen-1"]);
        expect(harness.settlements).toEqual([{ kind: "succeeded" }]);
    });
});

/** A run whose branch Autonoma does not host a preview for, so `resolvePreviewTarget` yields no target. */
async function startCustomerDeployedRun(): Promise<void> {
    executionCounter += 1;
    const handle = await env.client.workflow.start(analysisRunWorkflow, {
        taskQueue: TaskQueue.GENERAL,
        workflowId: trackedWorkflowId("customer-deployed-run-test"),
        args: [{ branchId: "branch-customer-deployed", headSha: `head-${executionCounter}` }],
    });
    await handle.result();
}
