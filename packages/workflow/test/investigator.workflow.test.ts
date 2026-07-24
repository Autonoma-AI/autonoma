import type { AnalysisFindingReport, AnalysisTestOrigin } from "@autonoma/types";
import type { AnalysisCandidateFinding } from "@autonoma/workflow/activities";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    ClassifyInvestigationRunInput,
    DeleteAnalysisTestInput,
    DeleteAnalysisTestOutput,
    InvestigationTestResult,
    InvestigationVerdict,
    PersistAnalysisFindingInput,
    PersistAnalysisFindingOutput,
    SelfHealAnalysisTestInput,
    SelfHealAnalysisTestOutput,
} from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { type InvestigatorWorkflowInput, investigatorWorkflow } from "../src/workflows/investigator.workflow";
import { createTimeSkippingTestEnvironment } from "./fixtures/test-workflow-environment";

// Compute the workflows bundle entrypoint directly rather than importing `workflowsPath` from ../src/worker: that
// barrel also re-exports the Node-side worker, which transitively imports @autonoma/db (its env.ts validates
// DATABASE_URL at import time). A hermetic workflow test must not require a database - CI runs it without one. The
// Temporal worker bundles this entrypoint in the sandbox, where no db import exists.
const workflowsPath = new URL("../src/workflows/index.ts", import.meta.url).pathname;

/**
 * Behavioral tests for the Investigator's verdict state machine: the self-heal loop, the full taxonomy (a
 * terminal verdict passes through, an exhausted `test_is_wrong` loop resolves to `delete` + self-deletes the
 * row), and containment (a classify fault is contained as a coverage-plane verdict, never a throw). They run the
 * REAL workflow in the time-skipping test environment with mocked activities, so the assertions are on observable
 * outcomes - the finding it emits, how many times the test re-ran, the plan-edit it authored, and whether it
 * self-deleted - not on internal calls. classify + self-heal + delete all resolve on the DIFFS queue (the
 * pipeline is re-homed into the diffs worker); the web run is the only other activity, and passing no scenario
 * means the GENERAL queue is never scheduled.
 */

const SLUG = "checkout-flow";
const ORIGINAL_GENERATION = "gen-original";
const HEALED_GENERATION = "gen-healed";
const REVISED_PLAN = "1. Open checkout.\n2. Assert the label the app actually shows.";

/** A mutable per-test script the mocked activities read, letting each test drive the classifier + re-run outcomes. */
interface Harness {
    /**
     * One classifier outcome per run, in order: a result, or an Error the classify activity throws (to exercise
     * containment). A run past the end throws a runaway-loop guard so an unbounded loop fails loudly.
     */
    classifyQueue: Array<InvestigationTestResult | Error>;
    /** Every classify input, captured to assert the self-heal re-run carries the prior pass's verdict. */
    classifyCalls: ClassifyInvestigationRunInput[];
    /** testGenerationIds actually handed to the web worker - i.e. how many times, and with what, the test ran. */
    webRuns: string[];
    /** Every plan-edit the loop authored, captured to assert scoping to this test's own (snapshot, testCase) rows. */
    selfHealCalls: SelfHealAnalysisTestInput[];
    /** What selfHealAnalysisTest returns (the prepared re-run generation, or a skip). */
    selfHealOutput: SelfHealAnalysisTestOutput;
    /** Every self-delete the loop requested, captured to assert the eager delete of the test's own row. */
    deleteCalls: DeleteAnalysisTestInput[];
    /** Every finding the Investigator persisted, captured to assert it files its own finding with its provenance. */
    persistCalls: AnalysisCandidateFinding[];
}

const harness: Harness = {
    classifyQueue: [],
    classifyCalls: [],
    webRuns: [],
    selfHealCalls: [],
    selfHealOutput: {},
    deleteCalls: [],
    persistCalls: [],
};

/** Monotonic counter for unique workflow ids across executions (workflow ids must not collide within the run). */
let executionCounter = 0;

function verdict(
    category: string,
    options: { suggestedTestUpdate?: string; headline?: string } = {},
): InvestigationVerdict {
    return {
        category,
        isClientBug: category === "client_bug",
        ran: true,
        confidence: "high",
        headline: options.headline ?? `verdict: ${category}`,
        falsePositiveRisk: "none",
        whatHappened: "n/a",
        rootCause: "n/a",
        remediation: "n/a",
        suggestedTestUpdate: options.suggestedTestUpdate,
        evidence: [{ source: "run", detail: "n/a" }],
    };
}

function classified(v: InvestigationVerdict): InvestigationTestResult {
    return { slug: SLUG, plan: "1. Open checkout.", runSuccess: v.category === "passed", stepCount: 2, verdict: v };
}

/**
 * The rich report the fixture's classified result yields on a terminal/delete finding - the classifier output the
 * pipeline now carries instead of discarding. Asserting it in the state-machine tests proves the capture happens
 * for every terminal path (undefined-valued media/trace keys are elided by `toEqual`).
 */
function expectedReport(overrides: Partial<AnalysisFindingReport> = {}): AnalysisFindingReport {
    return {
        confidence: "high",
        whatHappened: "n/a",
        rootCause: "n/a",
        remediation: "n/a",
        falsePositiveRisk: "none",
        plan: "1. Open checkout.",
        runSuccess: false,
        stepCount: 2,
        evidence: [{ source: "run", detail: "n/a" }],
        ...overrides,
    };
}

const analysisActivities = {
    async classifyInvestigationRun(input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult> {
        harness.classifyCalls.push(input);
        const next = harness.classifyQueue.shift();
        if (next == null) throw new Error("classify called more times than the test scripted (runaway loop?)");
        if (next instanceof Error) throw next;
        return next;
    },
    async selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput> {
        harness.selfHealCalls.push(input);
        return harness.selfHealOutput;
    },
    async deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput> {
        harness.deleteCalls.push(input);
        return { deleted: true };
    },
    async persistAnalysisFinding(input: PersistAnalysisFindingInput): Promise<PersistAnalysisFindingOutput> {
        harness.persistCalls.push(input.finding);
        return { findingKey: input.finding.slug };
    },
};

const webActivities = {
    async runWebGeneration(input: { testGenerationId: string }): Promise<void> {
        harness.webRuns.push(input.testGenerationId);
    },
};

let env: TestWorkflowEnvironment;
let runners: Promise<void>;
let workers: Worker[];

beforeAll(async () => {
    env = await createTimeSkippingTestEnvironment();
    const diffsWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.DIFFS,
        workflowsPath,
        activities: analysisActivities,
        // Preserve workflow function names so the client can resolve `investigatorWorkflow` from the bundle by name.
        bundlerOptions: {
            webpackConfigHook: (config) => {
                config.optimization = { ...config.optimization, minimize: false };
                return config;
            },
        },
    });
    const webWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.WEB,
        activities: webActivities,
    });
    workers = [diffsWorker, webWorker];
    runners = Promise.all(workers.map((worker) => worker.run())).then(() => undefined);
}, 120_000);

afterAll(async () => {
    for (const worker of workers ?? []) worker.shutdown();
    await runners?.catch(() => undefined);
    await env?.teardown();
});

beforeEach(() => {
    harness.classifyQueue = [];
    harness.classifyCalls = [];
    harness.webRuns = [];
    harness.selfHealCalls = [];
    harness.persistCalls = [];
    harness.selfHealOutput = { testGenerationId: HEALED_GENERATION, scenarioId: undefined };
    harness.deleteCalls = [];
});

function runInvestigator(origin: AnalysisTestOrigin = "pre_existing"): Promise<AnalysisCandidateFinding> {
    const input: InvestigatorWorkflowInput = {
        snapshotId: "snap-1",
        slug: SLUG,
        testGenerationId: ORIGINAL_GENERATION,
        reason: "diff touched checkout",
        origin,
    };
    executionCounter += 1;
    return env.client.workflow.execute(investigatorWorkflow, {
        taskQueue: TaskQueue.DIFFS,
        workflowId: `investigator-${SLUG}-${executionCounter}`,
        args: [input],
    });
}

describe("investigatorWorkflow verdict state machine", () => {
    it("rewrites the plan and re-runs when the first run shows the test itself is stale", async () => {
        harness.classifyQueue = [
            classified(verdict("outdated_test", { suggestedTestUpdate: REVISED_PLAN, headline: "stale assertion" })),
            classified(verdict("passed", { headline: "healed and green" })),
        ];

        const finding = await runInvestigator();

        // The healed second run's verdict is what the Investigator reports - proof the loop re-ran, not the first.
        // planEdited is true because a self-heal rewrite was applied along the way.
        expect(finding).toEqual({
            slug: SLUG,
            category: "passed",
            headline: "healed and green",
            planEdited: true,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
            selfHealNote: expect.any(String),
            report: expectedReport({ runSuccess: true }),
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION, HEALED_GENERATION]);
        // The plan-edit was authored against THIS test's own snapshot + test case, carrying the classifier's plan.
        expect(harness.selfHealCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, plan: REVISED_PLAN }]);
        expect(harness.deleteCalls).toHaveLength(0);
        // The re-run's classify carries the prior pass's verdict, so the second pass judges the corrected plan
        // against the first pass's conclusion instead of re-investigating from scratch.
        expect(harness.classifyCalls.map((call) => call.priorPass)).toEqual([
            undefined,
            { category: "outdated_test", headline: "stale assertion", rootCause: "n/a" },
        ]);
    });

    it("resolves to delete and self-deletes the row when the test never heals (loop exhausted)", async () => {
        harness.classifyQueue = [
            classified(verdict("outdated_test", { suggestedTestUpdate: REVISED_PLAN })),
            classified(verdict("outdated_test", { suggestedTestUpdate: REVISED_PLAN, headline: "still stale" })),
        ];

        const finding = await runInvestigator();

        // It ran exactly twice (initial + one self-heal) and the final iteration withheld the re-run, so a
        // still-`test_is_wrong` test on a healthy app resolves to `delete` - there is no "unknown"/passed bucket.
        expect(finding).toEqual({
            slug: SLUG,
            category: "delete",
            headline: "still stale",
            planEdited: true,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
            selfHealNote: expect.any(String),
            report: expectedReport(),
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION, HEALED_GENERATION]);
        // Only ONE plan-edit was authored (the final iteration does not request another re-run) ...
        expect(harness.selfHealCalls).toHaveLength(1);
        // ... and the Investigator eagerly self-deleted its OWN row on the twin, carrying the test's origin so the
        // activity removes only this affected test's assignment (not the whole TestCase).
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, origin: "pre_existing" }]);
    });

    it("resolves a proposed test to delete without re-running when the classifier proposes no revised plan", async () => {
        harness.classifyQueue = [classified(verdict("bad_test", { headline: "asserts a removed feature" }))];

        // A proposed (this-run-authored) test that cannot be established.
        const finding = await runInvestigator("proposed");

        // No suggestedTestUpdate (the feature is gone), so there is nothing to re-run: the correct-app test is
        // un-fixable and resolves straight to `delete` on the first pass, self-deleting its row.
        expect(finding).toEqual({
            slug: SLUG,
            category: "delete",
            headline: "asserts a removed feature",
            planEdited: false,
            origin: "proposed",
            selectionReason: "diff touched checkout",
            report: expectedReport(),
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.selfHealCalls).toHaveLength(0);
        // The proposed origin flows to the delete activity, which removes the whole (this-run-only) TestCase.
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, origin: "proposed" }]);
    });

    it("resolves to delete when a self-heal rewrite could not be prepared", async () => {
        // The classifier proposed a plan, but the self-heal activity could not prepare a generation (e.g. the
        // slug had no assignment) - so there is nothing to re-run and the test resolves to `delete`.
        harness.selfHealOutput = { skippedReason: "no assignment for this slug on the snapshot" };
        harness.classifyQueue = [
            classified(verdict("outdated_test", { suggestedTestUpdate: REVISED_PLAN, headline: "cannot prepare" })),
        ];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            category: "delete",
            headline: "cannot prepare",
            planEdited: false,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
            report: expectedReport(),
        });
        // The rewrite was requested once, but no re-run happened (no HEALED_GENERATION).
        expect(harness.selfHealCalls).toHaveLength(1);
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, origin: "pre_existing" }]);
    });

    it("does not self-heal a client bug - it is terminal on the first run", async () => {
        harness.classifyQueue = [classified(verdict("client_bug", { headline: "checkout total is wrong" }))];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            category: "client_bug",
            headline: "checkout total is wrong",
            planEdited: false,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
            report: expectedReport(),
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.selfHealCalls).toHaveLength(0);
        expect(harness.deleteCalls).toHaveLength(0);
        // The Investigator files its OWN finding (no cross-test Reconciler write), carrying the selection reason.
        expect(harness.persistCalls).toHaveLength(1);
        expect(harness.persistCalls[0]).toMatchObject({
            slug: SLUG,
            category: "client_bug",
            selectionReason: "diff touched checkout",
        });
    });

    it("passes a coverage-plane terminal (scenario_issue) straight through without self-healing", async () => {
        harness.classifyQueue = [classified(verdict("scenario_issue", { headline: "user was never seeded" }))];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            category: "scenario_issue",
            headline: "user was never seeded",
            planEdited: false,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
            report: expectedReport(),
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.deleteCalls).toHaveLength(0);
    });

    it("contains a classifier fault as engine_artifact rather than throwing", async () => {
        harness.classifyQueue = [new Error("model exploded during classification")];

        const finding = await runInvestigator();

        // A classify fault with no recognizable infra signal is the coverage-plane engine_artifact bucket - never
        // a silent drop, never a bug against the PR - and it carries the underlying message for debuggability.
        expect(finding.slug).toBe(SLUG);
        expect(finding.category).toBe("engine_artifact");
        expect(finding.planEdited).toBe(false);
        expect(finding.headline).toContain("model exploded during classification");
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.deleteCalls).toHaveLength(0);
    });

    it("attributes a recognizable infra fault to environment_failure", async () => {
        harness.classifyQueue = [new Error("SDK call timed out - ensure your endpoint is reachable")];

        const finding = await runInvestigator();

        // The SDK/timeout signature is a preview/environment failure, not the PR's fault and not an engine flake.
        expect(finding.category).toBe("environment_failure");
        expect(finding.planEdited).toBe(false);
    });
});
