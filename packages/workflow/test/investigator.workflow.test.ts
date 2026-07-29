import { type AnalysisClassificationReport, type AnalysisTestOrigin, analysisVerdictPlane } from "@autonoma/types";
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
    PersistAnalysisClassificationInput,
    PersistAnalysisClassificationOutput,
    MarkGenerationFailedInput,
    RevertSelfHealPlanInput,
    RevertSelfHealPlanOutput,
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
 * terminal verdict passes through; an exhausted `plan_mismatch` loop resolves to a KEPT `plan_mismatch` and reverts
 * its failed rewrite rather than removing the test; an `invalid_test` REMOVES the test - up front, or after a failed
 * heal), containment (a classify fault is contained as a coverage-plane verdict, never a throw), and what it
 * PERSISTS - one classification per iteration, the superseded one always written before the rewrite it motivates.
 * They run the REAL workflow in the time-skipping test environment with mocked activities, so the assertions are on
 * observable outcomes - the verdicts it files, how many times the test re-ran, the plan-edit it authored, whether it
 * reverted, whether it removed the test, and what it recorded about the generation it ran - not on internal calls.
 * classify + self-heal + revert + delete all resolve on the DIFFS queue (the pipeline is re-homed into the diffs
 * worker); the web run resolves on the WEB queue, and scenario provisioning + generation status on the GENERAL one.
 */

const SLUG = "checkout-flow";
const TEST_CASE_ID = "tc-checkout";
const ORIGINAL_GENERATION = "gen-original";
const HEALED_GENERATION = "gen-healed";
/** The plan the assignment pointed at before a self-heal - what a kept `plan_mismatch` restores. */
const ORIGINAL_PLAN_ID = "plan-original";
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
    /** Every test removal the loop requested - the `invalid_test` path fires it; the keep paths assert it never does. */
    deleteCalls: DeleteAnalysisTestInput[];
    /** What deleteAnalysisTest returns, so a test can drive the removal-failed fallback (`deleted: false`). */
    deleteOutput: DeleteAnalysisTestOutput;
    /** Every plan revert the loop requested, captured to assert a kept plan_mismatch restores its original plan. */
    revertCalls: RevertSelfHealPlanInput[];
    /** Every classification the Investigator filed, in order - the loop's whole record of what it concluded. */
    persistCalls: PersistAnalysisClassificationInput[];
    /** Ordered log of the writes the loop made, so a test can assert a verdict lands BEFORE the rewrite it causes. */
    events: string[];
    /** When set, scenario provisioning throws it - the run never reaches the app. */
    scenarioUpError?: Error;
    /** When set, the web activity throws it, standing in for a failure before the engine owned the generation. */
    webRunError?: Error;
    /** Every generation status the loop recorded, so a test can assert a run that never happened says so. */
    markFailedCalls: MarkGenerationFailedInput[];
}

const harness: Harness = {
    classifyQueue: [],
    classifyCalls: [],
    webRuns: [],
    selfHealCalls: [],
    selfHealOutput: { prepared: false, skippedReason: "not scripted" },
    deleteCalls: [],
    deleteOutput: { deleted: true },
    revertCalls: [],
    persistCalls: [],
    events: [],
    markFailedCalls: [],
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
 * The rich report the fixture's classified result yields on any terminal finding - the classifier output the
 * pipeline now carries instead of discarding. Asserting it in the state-machine tests proves the capture happens
 * for every terminal path (undefined-valued media/trace keys are elided by `toEqual`).
 */
function expectedReport(overrides: Partial<AnalysisClassificationReport> = {}): AnalysisClassificationReport {
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
        harness.events.push("selfHeal");
        return harness.selfHealOutput;
    },
    async revertSelfHealPlan(input: RevertSelfHealPlanInput): Promise<RevertSelfHealPlanOutput> {
        harness.revertCalls.push(input);
        harness.events.push("revert");
        return { reverted: true };
    },
    async deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput> {
        harness.deleteCalls.push(input);
        harness.events.push("delete");
        return harness.deleteOutput;
    },
    async persistAnalysisClassification(
        input: PersistAnalysisClassificationInput,
    ): Promise<PersistAnalysisClassificationOutput> {
        harness.persistCalls.push(input);
        harness.events.push(`persist:${input.classification.category}`);
        return { findingId: "finding-1", number: input.number };
    },
};

const webActivities = {
    async runWebGeneration(input: { testGenerationId: string }): Promise<void> {
        harness.webRuns.push(input.testGenerationId);
        const failure = harness.webRunError;
        if (failure != null) throw failure;
    },
};

const generalActivities = {
    async scenarioUp(input: { entityId: string; scenarioId: string }): Promise<{ scenarioInstanceId: string }> {
        harness.events.push("scenarioUp");
        if (harness.scenarioUpError != null) throw harness.scenarioUpError;
        return { scenarioInstanceId: `instance-${input.scenarioId}` };
    },
    async scenarioDown(): Promise<void> {
        harness.events.push("scenarioDown");
    },
    async markGenerationFailed(input: MarkGenerationFailedInput): Promise<void> {
        harness.markFailedCalls.push(input);
        harness.events.push(`markFailed:${input.failure.kind}`);
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
    const generalWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.GENERAL,
        activities: generalActivities,
    });
    workers = [diffsWorker, webWorker, generalWorker];
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
    harness.events = [];
    harness.selfHealOutput = {
        prepared: true,
        testGenerationId: HEALED_GENERATION,
        previousPlanId: ORIGINAL_PLAN_ID,
        scenarioId: undefined,
    };
    harness.deleteCalls = [];
    harness.deleteOutput = { deleted: true };
    harness.revertCalls = [];
    harness.scenarioUpError = undefined;
    harness.webRunError = undefined;
    harness.markFailedCalls = [];
});

function runInvestigator(
    origin: AnalysisTestOrigin = "pre_existing",
    scenarioId?: string,
): Promise<AnalysisCandidateFinding> {
    const input: InvestigatorWorkflowInput = {
        snapshotId: "snap-1",
        slug: SLUG,
        testCaseId: TEST_CASE_ID,
        testGenerationId: ORIGINAL_GENERATION,
        scenarioId,
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
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN, headline: "stale assertion" })),
            classified(verdict("passed", { headline: "healed and green" })),
        ];

        const finding = await runInvestigator();

        // The healed second run's verdict is what the Investigator reports - proof the loop re-ran, not the first -
        // and it points at the HEALED generation: the verdict must name the run it actually judged.
        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: HEALED_GENERATION,
            category: "passed",
            headline: "healed and green",
            origin: "pre_existing",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION, HEALED_GENERATION]);

        // Both iterations were filed, each pinned to the run it judged - the superseded `plan_mismatch` verdict
        // (the one that authored the rewrite) survives the pass that replaced it, which is the whole point.
        expect(
            harness.persistCalls.map((call) => [call.classification.category, call.classification.generationId]),
        ).toEqual([
            ["plan_mismatch", ORIGINAL_GENERATION],
            ["passed", HEALED_GENERATION],
        ]);
        // Each is filed under the loop's own iteration counter, so re-filing one restates it rather than inventing
        // a third iteration - the store never has to count rows to decide which slot it is writing.
        expect(harness.persistCalls.map((call) => call.number)).toEqual([1, 2]);
        // ... and it was filed BEFORE the rewrite it motivated: a plan must never be edited on the strength of a
        // verdict that is not yet on disk.
        expect(harness.events).toEqual(["persist:plan_mismatch", "selfHeal", "persist:passed"]);
        // The per-test provenance rides onto the finding from the ORIGINAL selection reason, not the re-run's.
        expect(harness.persistCalls.map((call) => call.selectionReason)).toEqual([
            "diff touched checkout",
            "diff touched checkout",
        ]);
        // The plan-edit was authored against THIS test's own snapshot + test case, carrying the classifier's plan.
        expect(harness.selfHealCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, plan: REVISED_PLAN }]);
        // A passed re-run KEEPS the rewrite - the self-heal succeeded, so there is nothing to revert.
        expect(harness.revertCalls).toHaveLength(0);
        // The re-run's classify carries the prior pass's verdict, so the second pass judges the corrected plan
        // against the first pass's conclusion instead of re-investigating from scratch.
        expect(harness.classifyCalls.map((call) => call.priorPass)).toEqual([
            undefined,
            { category: "plan_mismatch", headline: "stale assertion", rootCause: "n/a" },
        ]);
    });

    it("keeps the test as plan_mismatch and reverts the rewrite when it never heals (loop exhausted)", async () => {
        harness.classifyQueue = [
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN })),
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN, headline: "still stale" })),
        ];

        const finding = await runInvestigator();

        // It ran exactly twice (initial + one self-heal) and the final iteration withheld the re-run, so a
        // still-wrong test on a healthy app resolves to a KEPT `plan_mismatch` - never removed, never a bug.
        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: HEALED_GENERATION,
            category: "plan_mismatch",
            headline: "still stale",
            origin: "pre_existing",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION, HEALED_GENERATION]);
        // Only ONE plan-edit was authored (the final iteration does not request another re-run) ...
        expect(harness.selfHealCalls).toHaveLength(1);
        // ... the kept test is NOT removed ...
        expect(harness.deleteCalls).toHaveLength(0);
        // ... and the failed rewrite is undone by repointing the assignment at the plan record it replaced, so the
        // original plan is what promotes (a rewrite optimized to pass can blunt the assertion catching a real bug).
        expect(harness.revertCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, planId: ORIGINAL_PLAN_ID }]);
        // Both iterations file `plan_mismatch` (the terminal is the same value the classifier routed on); the
        // earlier iteration keeps its own row, with the evidence carried onto both.
        expect(harness.persistCalls.map((call) => call.classification.category)).toEqual([
            "plan_mismatch",
            "plan_mismatch",
        ]);
        expect(harness.persistCalls[1]?.classification.report).toEqual(expectedReport());
        // The verdict is recorded before the revert it explains.
        expect(harness.events).toEqual(["persist:plan_mismatch", "selfHeal", "persist:plan_mismatch", "revert"]);
    });

    it("keeps a proposed test as plan_mismatch without re-running when the classifier proposes no revised plan", async () => {
        harness.classifyQueue = [classified(verdict("plan_mismatch", { headline: "asserts a removed feature" }))];

        // A proposed (this-run-authored) test that cannot be established.
        const finding = await runInvestigator("proposed");

        // No suggestedTestUpdate (no viable rewrite), so there is nothing to re-run: the correct-app test resolves
        // straight to a KEPT `plan_mismatch` on the first pass - not removed, and no rewrite was applied to revert.
        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: ORIGINAL_GENERATION,
            category: "plan_mismatch",
            headline: "asserts a removed feature",
            origin: "proposed",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.selfHealCalls).toHaveLength(0);
        expect(harness.revertCalls).toHaveLength(0);
        // One iteration, filed as the `plan_mismatch` it resolved to, carrying the run's evidence.
        expect(harness.persistCalls).toHaveLength(1);
        expect(harness.persistCalls[0]?.classification).toEqual({
            generationId: ORIGINAL_GENERATION,
            category: "plan_mismatch",
            headline: "asserts a removed feature",
            report: expectedReport(),
        });
    });

    it("keeps as plan_mismatch when a self-heal rewrite could not be prepared", async () => {
        // The classifier proposed a plan, but the self-heal activity could not prepare a generation (e.g. the
        // slug had no assignment) - so no rewrite landed and nothing re-ran; the test is kept as plan_mismatch.
        harness.selfHealOutput = { prepared: false, skippedReason: "no assignment for this slug on the snapshot" };
        harness.classifyQueue = [
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN, headline: "cannot prepare" })),
        ];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: ORIGINAL_GENERATION,
            category: "plan_mismatch",
            headline: "cannot prepare",
            origin: "pre_existing",
        });
        // The rewrite was requested once, but no re-run happened (no HEALED_GENERATION) ...
        expect(harness.selfHealCalls).toHaveLength(1);
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        // ... and since no rewrite actually landed, there is nothing to revert.
        expect(harness.revertCalls).toHaveLength(0);
        // The verdict is filed ONCE, before the rewrite is attempted: a plan is never edited on the strength of a
        // verdict that is not on disk, and a rewrite that never landed leaves that one record standing as the terminal.
        expect(harness.events).toEqual(["persist:plan_mismatch", "selfHeal"]);
    });

    it("removes the test up front on an invalid_test verdict, without self-healing", async () => {
        // The classifier proved the test is irreparable (a feature that never existed) on the FIRST pass - a
        // provable impossibility is reachable up front, skipping self-heal.
        harness.classifyQueue = [
            classified(verdict("invalid_test", { headline: "asserts a feature that never existed" })),
        ];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: ORIGINAL_GENERATION,
            category: "invalid_test",
            headline: "asserts a feature that never existed",
            origin: "pre_existing",
        });
        // It ran once and did NOT self-heal (invalid_test is terminal) ...
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.selfHealCalls).toHaveLength(0);
        expect(harness.revertCalls).toHaveLength(0);
        // ... the test's assignment is removed via the uniform RemoveTest path ...
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG }]);
        // ... and the removal happens AFTER the verdict is on disk, so the classification record (the WHY) survives.
        expect(harness.persistCalls).toHaveLength(1);
        expect(harness.persistCalls[0]?.classification.category).toBe("invalid_test");
        expect(harness.persistCalls[0]?.classification.report).toEqual(expectedReport());
        expect(harness.events).toEqual(["persist:invalid_test", "delete"]);
    });

    it("removes the test when a self-heal re-run proves it invalid", async () => {
        // A softer wrong-test case routes through plan_mismatch -> self-heal first; the re-run then establishes the
        // test is irreparable - so it lands on invalid_test and the test is removed.
        harness.classifyQueue = [
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN })),
            classified(verdict("invalid_test", { headline: "unrecoverable even after the rewrite" })),
        ];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: HEALED_GENERATION,
            category: "invalid_test",
            headline: "unrecoverable even after the rewrite",
            origin: "pre_existing",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION, HEALED_GENERATION]);
        // It self-healed once before concluding the test is invalid ...
        expect(harness.selfHealCalls).toHaveLength(1);
        // ... the test is REMOVED, not reverted: the assignment is gone, so restoring its old plan is moot.
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG }]);
        expect(harness.revertCalls).toHaveLength(0);
        // Both iterations filed; the terminal invalid_test lands after the self-heal, and the removal comes last.
        expect(harness.persistCalls.map((call) => call.classification.category)).toEqual([
            "plan_mismatch",
            "invalid_test",
        ]);
        expect(harness.events).toEqual(["persist:plan_mismatch", "selfHeal", "persist:invalid_test", "delete"]);
    });

    it("reverts the self-heal rewrite when a post-heal invalid_test cannot actually be removed", async () => {
        // The post-heal removal path already repointed the assignment at a rewrite the run knows fails. If the removal
        // does NOT land (here: deleted:false), that failing rewrite would otherwise promote - so the loop must undo it
        // by restoring the plan the loop started from, the same guarantee the kept-plan_mismatch path gives.
        harness.deleteOutput = { deleted: false, reason: "no assignment for this slug on the snapshot" };
        harness.classifyQueue = [
            classified(verdict("plan_mismatch", { suggestedTestUpdate: REVISED_PLAN })),
            classified(verdict("invalid_test", { headline: "unrecoverable even after the rewrite" })),
        ];

        const finding = await runInvestigator();

        expect(finding.category).toBe("invalid_test");
        // The removal was attempted but reported nothing dropped ...
        expect(harness.deleteCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG }]);
        // ... so the failed rewrite is undone: the assignment is restored to the plan the loop started from.
        expect(harness.revertCalls).toEqual([{ snapshotId: "snap-1", slug: SLUG, planId: ORIGINAL_PLAN_ID }]);
        // The revert runs AFTER the removal attempt, and only because it came back empty.
        expect(harness.events).toEqual([
            "persist:plan_mismatch",
            "selfHeal",
            "persist:invalid_test",
            "delete",
            "revert",
        ]);
    });

    it("does not self-heal a client bug - it is terminal on the first run", async () => {
        harness.classifyQueue = [classified(verdict("client_bug", { headline: "checkout total is wrong" }))];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: ORIGINAL_GENERATION,
            category: "client_bug",
            headline: "checkout total is wrong",
            origin: "pre_existing",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        expect(harness.selfHealCalls).toHaveLength(0);
        // The Investigator files its own verdict (no cross-test Reconciler write), with the test it is about, the
        // selection provenance, and the classifier's full evidence.
        expect(harness.persistCalls).toHaveLength(1);
        expect(harness.persistCalls[0]).toMatchObject({
            snapshotId: "snap-1",
            testCaseId: TEST_CASE_ID,
            origin: "pre_existing",
            selectionReason: "diff touched checkout",
        });
        expect(harness.persistCalls[0]?.classification.report).toEqual(expectedReport());
    });

    it("passes a coverage-plane terminal (scenario_issue) straight through without self-healing", async () => {
        harness.classifyQueue = [classified(verdict("scenario_issue", { headline: "user was never seeded" }))];

        const finding = await runInvestigator();

        expect(finding).toEqual({
            slug: SLUG,
            testCaseId: TEST_CASE_ID,
            generationId: ORIGINAL_GENERATION,
            category: "scenario_issue",
            headline: "user was never seeded",
            origin: "pre_existing",
        });
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
    });

    it("contains a classifier fault as engine_artifact rather than throwing", async () => {
        harness.classifyQueue = [new Error("model exploded during classification")];

        const finding = await runInvestigator();

        // A classify fault with no recognizable infra signal is the coverage-plane engine_artifact bucket - never
        // a silent drop, never a bug against the PR - and it carries the underlying message for debuggability.
        expect(finding.slug).toBe(SLUG);
        expect(finding.category).toBe("engine_artifact");
        expect(finding.headline).toContain("model exploded during classification");
        expect(harness.webRuns).toEqual([ORIGINAL_GENERATION]);
        // A fault is still filed - never a silent drop - with its category and headline but no classifier output.
        expect(harness.persistCalls).toHaveLength(1);
        expect(harness.persistCalls[0]?.classification.report).toBeUndefined();
    });

    it("attributes a recognizable infra fault to environment_failure", async () => {
        harness.classifyQueue = [new Error("SDK call timed out - ensure your endpoint is reachable")];

        const finding = await runInvestigator();

        // The SDK/timeout signature is a preview/environment failure, not the PR's fault and not an engine flake.
        expect(finding.category).toBe("environment_failure");
    });

    it("records why the generation failed when scenario setup blocks it before the app is exercised", async () => {
        harness.scenarioUpError = new Error("HTTP 400: no factory is registered for the emails model");

        const finding = await runInvestigator("pre_existing", "scenario-1");

        // The app was never reached, so the test is contained on the coverage plane and never runs.
        expect(analysisVerdictPlane(finding.category)).toBe("coverage");
        expect(harness.webRuns).toEqual([]);
        // The generation itself carries WHY it never ran, in the customer's own words - without this it stays
        // `pending`, and a pending generation is swept at settlement, taking this test's verdict with it.
        expect(harness.markFailedCalls).toEqual([
            {
                testGenerationId: ORIGINAL_GENERATION,
                failure: {
                    kind: "scenario_setup",
                    message: "HTTP 400: no factory is registered for the emails model",
                },
            },
        ]);
        // The verdict is still filed, and only after the generation's status is on disk.
        expect(harness.events.slice(0, 2)).toEqual(["scenarioUp", "markFailed:scenario_setup"]);
        expect(harness.persistCalls).toHaveLength(1);
    });

    it("records an engine failure when the run errors before the engine owns the generation", async () => {
        harness.webRunError = new Error("activity task timed out before the worker started");
        harness.classifyQueue = [classified(verdict("passed", { headline: "green anyway" }))];

        await runInvestigator();

        // The engine normally writes its own terminal status; this covers the window before it can, where the
        // generation would otherwise be abandoned mid-`pending`.
        expect(harness.markFailedCalls).toEqual([
            {
                testGenerationId: ORIGINAL_GENERATION,
                failure: { kind: "engine_error", message: "activity task timed out before the worker started" },
            },
        ]);
        // A failed run is still classified - the failure IS the signal - so the status write must not short-circuit it.
        expect(harness.classifyCalls).toHaveLength(1);
    });

    it("leaves the generation alone when the run completes", async () => {
        harness.classifyQueue = [classified(verdict("passed"))];

        await runInvestigator();

        // Nothing to record: the engine owns the status of a generation it actually ran.
        expect(harness.markFailedCalls).toEqual([]);
    });
});
