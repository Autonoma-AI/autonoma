import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/ui/prompts", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import {
    describeDryRunOutcome,
    pickDryRunTarget,
    runDryRunPhase,
    type DryRunReader,
    type DryRunTarget,
} from "../../src/core/dry-run-phase";

const APP_ID = "app_1";
const TIMING = { pollMs: 1, readyTimeoutMs: 50, noPreviewGraceMs: 50 };

function target(overrides: Partial<DryRunTarget> = {}): DryRunTarget {
    return {
        id: "pr-7",
        label: "feat: autonoma-sdk",
        source: "previewkit",
        availability: "ready",
        sdkUrl: "https://pr-7.example.test/api/autonoma",
        ...overrides,
    };
}

interface FakeClient extends DryRunReader {
    dryRuns: string[];
    discoverCalls: boolean[];
    prepareCalls: number;
}

interface FakeOptions {
    /** Successive answers from `listDryRunTargets`; the last repeats. */
    targets?: DryRunTarget[][];
    autoDetectedTargetId?: string;
    scenarios?: { id: string; name: string }[];
    prepare?: "ready" | "redeploy_started";
    /** Successive answers from discover; the last repeats. A string throws instead. */
    discover?: ("discovered" | "redeploy_started" | string)[];
    /** Scenario ids that fail, mapped to how. */
    failures?: Record<string, { phase?: string; error?: unknown } | "throws">;
}

function fakeClient(options: FakeOptions = {}): FakeClient {
    const targetQueue = options.targets ?? [[target()]];
    const discoverQueue = options.discover ?? ["discovered"];
    let targetIndex = 0;
    let discoverIndex = 0;

    const fake: FakeClient = {
        dryRuns: [],
        discoverCalls: [],
        prepareCalls: 0,

        listDryRunTargets: () => {
            const targets = targetQueue[Math.min(targetIndex, targetQueue.length - 1)] ?? [];
            targetIndex++;
            return Promise.resolve({ targets, autoDetectedTargetId: options.autoDetectedTargetId });
        },
        listScenarios: () => Promise.resolve(options.scenarios ?? [{ id: "sc_1", name: "logged-in admin" }]),
        prepareSdkTarget: () => {
            fake.prepareCalls++;
            return Promise.resolve({ status: options.prepare ?? "ready" });
        },
        configureAndDiscoverSdkTarget: (_appId, _targetId, allowSelfHeal) => {
            fake.discoverCalls.push(allowSelfHeal);
            const answer = discoverQueue[Math.min(discoverIndex, discoverQueue.length - 1)] ?? "discovered";
            discoverIndex++;
            if (answer !== "discovered" && answer !== "redeploy_started") return Promise.reject(new Error(answer));
            return Promise.resolve({ status: answer });
        },
        runScenarioDryRun: (_appId, scenarioId) => {
            fake.dryRuns.push(scenarioId);
            const failure = options.failures?.[scenarioId];
            if (failure == null) return Promise.resolve({ success: true, phase: "down" });
            if (failure === "throws") return Promise.reject(new Error("recipe could not resolve"));
            return Promise.resolve({ success: false, phase: failure.phase, error: failure.error });
        },
    };
    return fake;
}

describe("pickDryRunTarget", () => {
    // The auto-detected PR is the only preview whose code carries the SDK handler, so
    // it wins even mid-build - the ready main preview would 404 every provisioning call.
    test("prefers the pull request the platform flagged as the SDK's, even while it builds", () => {
        const chosen = pickDryRunTarget({
            targets: [
                target({ id: "pr-7", availability: "building", sdkUrl: undefined }),
                target({ id: "main", availability: "ready" }),
            ],
            autoDetectedTargetId: "pr-7",
        });

        expect(chosen?.id).toBe("pr-7");
    });

    test("falls back to a preview that is already up", () => {
        const chosen = pickDryRunTarget({
            targets: [target({ id: "pr-9", availability: "no_preview", sdkUrl: undefined }), target({ id: "main" })],
        });

        expect(chosen?.id).toBe("main");
    });

    test("picks nothing when no preview is up and none is flagged", () => {
        const chosen = pickDryRunTarget({
            targets: [target({ id: "pr-9", availability: "building", sdkUrl: undefined })],
        });

        expect(chosen).toBeUndefined();
    });
});

describe("runDryRunPhase", () => {
    test("validates the preview, then provisions every scenario against it", async () => {
        const client = fakeClient({
            scenarios: [
                { id: "sc_1", name: "logged-in admin" },
                { id: "sc_2", name: "empty account" },
            ],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({ kind: "passed", scenarios: 2 });
        expect(client.prepareCalls).toBe(1);
        // Self-healing is offered on the first attempt only.
        expect(client.discoverCalls).toEqual([true]);
        expect(client.dryRuns).toEqual(["sc_1", "sc_2"]);
    });

    test("reports which scenarios failed, and how far each got", async () => {
        const client = fakeClient({
            scenarios: [
                { id: "sc_1", name: "logged-in admin" },
                { id: "sc_2", name: "empty account" },
            ],
            failures: { sc_2: { phase: "up", error: "no factory for Invoice" } },
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({
            kind: "failed",
            passed: 1,
            failures: [{ scenario: "empty account", phase: "up", reason: "no factory for Invoice" }],
        });
    });

    // A dry run that throws never reaches the SDK, so it leaves no instance and no
    // preview logs - the thrown message is the only evidence there is.
    test("keeps the reason when a dry run throws instead of resolving", async () => {
        const client = fakeClient({ failures: { sc_1: "throws" } });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({
            kind: "failed",
            passed: 0,
            failures: [{ scenario: "logged-in admin", phase: undefined, reason: "recipe could not resolve" }],
        });
    });

    test("waits for a preview that is still building", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            targets: [
                [target({ availability: "building", sdkUrl: undefined })],
                [target({ availability: "building", sdkUrl: undefined })],
                [target({ availability: "ready" })],
            ],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({ kind: "passed", scenarios: 1 });
    });

    // A failed deploy fails the same way on every poll, and its own reason is more
    // use than waiting out the deadline to say nothing.
    test("stops on a failed deploy rather than waiting it out", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            targets: [[target({ availability: "failed", error: "npm install exited 1", sdkUrl: undefined })]],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("no-target");
        expect(outcome.kind === "no-target" && outcome.reason).toContain("npm install exited 1");
        expect(client.dryRuns).toEqual([]);
    });

    test("gives up on a preview that never comes up", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            targets: [[target({ availability: "building", sdkUrl: undefined })]],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("no-target");
        expect(client.dryRuns).toEqual([]);
    });

    // A draft pull request reads no_preview forever. Waiting the build ceiling out
    // would report a build that never started, so it stops on its own shorter window
    // and says what is actually wrong.
    test("stops early on a flagged pull request that has no preview at all", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            targets: [[target({ availability: "no_preview", sdkUrl: undefined })]],
        });

        const outcome = await runDryRunPhase({
            client,
            applicationId: APP_ID,
            timing: { pollMs: 1, readyTimeoutMs: 10_000, noPreviewGraceMs: 5 },
        });

        expect(outcome.kind).toBe("no-target");
        const reason = outcome.kind === "no-target" ? outcome.reason : "";
        expect(reason).toMatch(/no preview environment/i);
        expect(reason).toMatch(/draft/i);
        expect(reason).not.toMatch(/still building/i);
        expect(client.dryRuns).toEqual([]);
    });

    // The same state is what a just-opened pull request looks like for a moment, so
    // the window has to be a grace period rather than an immediate refusal.
    test("keeps waiting when a preview appears within the grace window", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            targets: [
                [target({ availability: "no_preview", sdkUrl: undefined })],
                [target({ availability: "building", sdkUrl: undefined })],
                [target({ availability: "ready" })],
            ],
        });

        const outcome = await runDryRunPhase({
            client,
            applicationId: APP_ID,
            timing: { pollMs: 1, readyTimeoutMs: 10_000, noPreviewGraceMs: 10_000 },
        });

        expect(outcome.kind).toBe("passed");
    });

    test("waits out the redeploy that mounting the Autonoma secrets started", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            prepare: "redeploy_started",
            targets: [[target({ availability: "ready" })], [target({ availability: "ready" })]],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({ kind: "passed", scenarios: 1 });
    });

    // The redeploy IS the fix for a rejected signature, so it is worth one wait - and
    // the retry disallows another, so a rejection that survives it surfaces.
    test("retries discovery once after a self-healing redeploy, then stops asking for one", async () => {
        const client = fakeClient({
            autoDetectedTargetId: "pr-7",
            discover: ["redeploy_started", "discovered"],
            targets: [[target()], [target()]],
        });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({ kind: "passed", scenarios: 1 });
        expect(client.discoverCalls).toEqual([true, false]);
    });

    test("reports a handler that never answered, and does not attempt the scenarios", async () => {
        const client = fakeClient({ discover: ["500 Internal Server Error"] });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("discovery-failed");
        expect(outcome.kind === "discovery-failed" && outcome.reason).toContain("500 Internal Server Error");
        expect(client.dryRuns).toEqual([]);
    });

    test("reports nothing to run when the app has no scenarios", async () => {
        const client = fakeClient({ scenarios: [] });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome).toEqual({ kind: "no-scenarios" });
        expect(client.prepareCalls).toBe(0);
    });

    test("reports no preview at all when the app has none listed", async () => {
        const client = fakeClient({ targets: [[]] });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("no-target");
    });

    // The secret a customer's own pipeline signs with never leaves their side, so this
    // is a human action rather than a gap to fill later - and it must say so.
    test("refuses a preview from the project's own pipeline instead of failing at it", async () => {
        const client = fakeClient({ targets: [[target({ source: "external" })]] });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("unsupported-target");
        expect(outcome.kind === "unsupported-target" && outcome.reason).toContain("signing secret");
        expect(client.prepareCalls).toBe(0);
    });

    test("refuses a Vercel deployment the user has not picked", async () => {
        const client = fakeClient({ targets: [[target({ source: "vercel" })]] });

        const outcome = await runDryRunPhase({ client, applicationId: APP_ID, timing: TIMING });

        expect(outcome.kind).toBe("unsupported-target");
        expect(outcome.kind === "unsupported-target" && outcome.reason).toContain("Vercel");
    });
});

describe("describeDryRunOutcome", () => {
    test("says nothing when every scenario provisioned", () => {
        expect(describeDryRunOutcome({ kind: "passed", scenarios: 3 })).toBeUndefined();
    });

    test("counts the failures it does not quote", () => {
        const message = describeDryRunOutcome({
            kind: "failed",
            passed: 0,
            failures: [
                { scenario: "one", phase: "up" },
                { scenario: "two", phase: "up" },
                { scenario: "three", phase: "up" },
                { scenario: "four", phase: "up" },
            ],
        });

        expect(message).toContain("4 of 4 scenarios");
        expect(message).toContain("one");
        expect(message).toContain("...and 1 more");
        expect(message).not.toContain("four");
    });
});
