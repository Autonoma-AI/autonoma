import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/ui/prompts", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import type { DryRunTarget } from "../../src/core/dry-run-phase";
import {
    describeFinishPhase,
    runFinishPhase,
    type FinishPhaseResult,
    type FinishReader,
    type FinishState,
} from "../../src/core/finish-phase";

const APP_ID = "app_1";
const TIMING = { pollMs: 1, readyTimeoutMs: 50, noPreviewGraceMs: 50 };

const READY_TARGET: DryRunTarget = {
    id: "pr-7",
    label: "feat: autonoma-sdk",
    source: "previewkit",
    availability: "ready",
    sdkUrl: "https://pr-7.example.test/api/autonoma",
};

function fakeClient(state: FinishState, dryRunPasses = true): FinishReader {
    return {
        getOnboardingState: () => Promise.resolve(state),
        listDryRunTargets: () => Promise.resolve({ targets: [READY_TARGET], autoDetectedTargetId: "pr-7" }),
        listScenarios: () => Promise.resolve([{ id: "sc_1", name: "logged-in admin" }]),
        prepareSdkTarget: () => Promise.resolve({ status: "ready" }),
        configureAndDiscoverSdkTarget: () => Promise.resolve({ status: "discovered" }),
        runScenarioDryRun: () =>
            Promise.resolve(
                dryRunPasses
                    ? { success: true, phase: "down" }
                    : { success: false, phase: "up", error: "no factory for Invoice" },
            ),
    };
}

function liveState(overrides: Partial<FinishState> = {}): FinishState {
    return { step: "completed", artifactsUploaded: true, sdkConfigured: true, dryRunPassed: true, ...overrides };
}

function result(overrides: Partial<FinishPhaseResult> = {}): FinishPhaseResult {
    return { dryRun: { kind: "passed", scenarios: 1 }, state: liveState(), live: true, ...overrides };
}

describe("runFinishPhase", () => {
    test("runs the dry run and reads back where the app stands", async () => {
        const outcome = await runFinishPhase({
            client: fakeClient(liveState()),
            applicationId: APP_ID,
            timing: TIMING,
        });

        expect(outcome.dryRun).toEqual({ kind: "passed", scenarios: 1 });
        expect(outcome.live).toBe(true);
        expect(outcome.state.dryRunPassed).toBe(true);
    });

    // Going live is the agent's move, made as soon as the preview was verified. This
    // reports whether it happened; it must never infer it from its own dry run passing.
    test("reports an app that was never taken live, even when the dry run passed", async () => {
        const outcome = await runFinishPhase({
            client: fakeClient(liveState({ step: "preview_verified" })),
            applicationId: APP_ID,
            timing: TIMING,
        });

        expect(outcome.dryRun.kind).toBe("passed");
        expect(outcome.live).toBe(false);
    });

    test("still reads the state back when the dry run fails", async () => {
        const outcome = await runFinishPhase({
            client: fakeClient(liveState({ dryRunPassed: false }), false),
            applicationId: APP_ID,
            timing: TIMING,
        });

        expect(outcome.dryRun.kind).toBe("failed");
        expect(outcome.live).toBe(true);
    });
});

describe("describeFinishPhase", () => {
    test("says what Autonoma can now do with the app", () => {
        const lines = describeFinishPhase(result());

        expect(lines).toEqual([
            "Test suite: uploaded to Autonoma",
            "Autonoma SDK: connected to your app",
            "Scenario data: provisions against your preview",
            "Autonoma is reviewing your pull requests.",
        ]);
    });

    // The state is the platform's, not this run's: a step someone finished by hand
    // between runs reads as done, and one this run failed reads as outstanding.
    test("reads each line off onboarding state rather than off the run", () => {
        const lines = describeFinishPhase(
            result({
                dryRun: { kind: "failed", passed: 0, failures: [{ scenario: "logged-in admin" }] },
                state: liveState({ step: "preview_verified", sdkConfigured: false, dryRunPassed: false }),
                live: false,
            }),
        );

        expect(lines[1]).toBe("Autonoma SDK: not answering yet");
        expect(lines[2]).toBe("Scenario data: not confirmed yet");
        expect(lines[3]).toContain("not reviewing your pull requests yet");
    });

    // An app with nothing to provision is finished, not stuck - "not confirmed yet"
    // would read as a step the user still owes.
    test("distinguishes an app with no scenarios from one whose dry run is outstanding", () => {
        const lines = describeFinishPhase(
            result({ dryRun: { kind: "no-scenarios" }, state: liveState({ dryRunPassed: false }) }),
        );

        expect(lines[2]).toBe("Scenario data: no scenarios to provision");
    });
});
