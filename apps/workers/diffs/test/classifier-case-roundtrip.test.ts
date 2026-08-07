import type { RunFacts } from "@autonoma/diffs/analysis";
import { describe, expect, it } from "vitest";
import {
    type ClassifierCaseSource,
    classifierCaseInputSchema,
    rehydrateClassifierInput,
    serializeClassifierInput,
} from "../evals/classifier/classifier-input";

/**
 * The frozen corpus lives in a separate private repo, so nothing here can load a real case. What CAN be proven
 * without it is the property the corpus depends on: that freezing an assembled classification and rehydrating
 * it returns the same facts, through JSON, with the media reduced to addresses. A silent loss here would not
 * fail loudly - it would quietly grade the classifier on less than it had in production.
 */

const RUN: RunFacts = {
    success: false,
    finishReason: "failed",
    stepCount: 2,
    steps: ["1. [click] success", "2. [assert] failed"],
    reasoning: "the assertion never saw the toast",
    startEpoch: 1_770_000_000,
    endEpoch: 1_770_000_120,
    inspectableSteps: [
        {
            order: 1,
            interaction: "click",
            status: "success",
            screenshotBeforeKey: "shots/1-before.png",
            screenshotAfterKey: "shots/1-after.png",
            overlayPoints: [{ x: 10, y: 20, role: "click" }],
            params: { description: "the submit button" },
            output: { point: { x: 10, y: 20 } },
        },
        { order: 2, interaction: "assert", status: "failed", error: "toast not found", errorName: "AssertionError" },
    ],
    architecture: "WEB",
};

const SOURCE: ClassifierCaseSource = {
    coords: { owner: "acme", repo: "storefront", installationId: 42, baseSha: "b".repeat(40), headSha: "h".repeat(40) },
    appSlug: "storefront",
    prNumber: 1234,
    test: { slug: "checkout-happy-path", plan: "1. Log in\n2. Check out", affectedReason: "The diff touches checkout" },
    provision: { status: "up", detail: "Valid auth credentials WERE returned", seeded: "User=1, Order=3" },
    diffSummary: " src/checkout.ts | 12 ++++---",
    prTitle: "Speed up checkout",
    prBody: "Debounces the submit handler.",
    priorPass: { category: "plan_mismatch", headline: "The test asserted an old toast", rootCause: "stale copy" },
    run: RUN,
    recording: { key: "gen/abc/video.mp4", isOptimizedMp4: true },
    finalScreenshotKey: "gen/abc/final.png",
    baseline: "Prior runs (most recent 3):\n- ever passed: YES",
    previewEnvNames: ["DATABASE_URL", "NEXT_PUBLIC_APP_URL", "STRIPE_SECRET_KEY"],
    appLogs: {
        namespace: "preview-acme-storefront-pr-1234",
        lines: [{ timestampNs: "1770000060000000000", line: "ERROR checkout failed: ECONNREFUSED" }],
        windowTruncated: false,
    },
    productionCapabilities: { previewEnv: true, previewScript: true, appLogs: true },
};

/** A window that filled its own capture cap, so replay must warn about older matches it never froze. */
const TRUNCATED_WINDOW = {
    namespace: "preview-acme-storefront-pr-1234",
    lines: [
        { timestampNs: "1770000060000000000", line: "ERROR checkout failed: ECONNREFUSED" },
        { timestampNs: "1770000061000000000", line: "WARN retrying in 500ms" },
    ],
    windowTruncated: true,
};

/** Freeze, serialize to JSON and back, then reparse - exactly what the loader does with an on-disk case. */
function throughDisk(source: ClassifierCaseSource) {
    const frozen = serializeClassifierInput(source);
    return classifierCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
}

describe("classifier eval case round-trip", () => {
    it("preserves the classifier's facts through a freeze and a rehydrate", () => {
        const { coords, input, baseline } = rehydrateClassifierInput(throughDisk(SOURCE));

        expect(coords).toEqual(SOURCE.coords);
        expect(baseline).toBe(SOURCE.baseline);
        expect(input.test).toEqual(SOURCE.test);
        expect(input.provision).toEqual(SOURCE.provision);
        expect(input.priorPass).toEqual(SOURCE.priorPass);
        expect(input.diffSummary).toBe(SOURCE.diffSummary);
        expect(input.run.steps).toEqual(RUN.steps);
        expect(input.run.inspectableSteps).toEqual(RUN.inspectableSteps);
        expect(input.run.architecture).toBe("WEB");
    });

    it("reads the SHAs the classifier renders from the coords, so they cannot disagree with the clone", () => {
        const { coords, input } = rehydrateClassifierInput(throughDisk(SOURCE));

        expect(input.baseSha).toBe(coords.baseSha);
        expect(input.headSha).toBe(coords.headSha);
    });

    it("stores the run's media as addresses the evaluation fetches", () => {
        const frozen = throughDisk(SOURCE);

        expect(frozen.run.recording).toEqual({ key: "gen/abc/video.mp4", isOptimizedMp4: true });
        expect(frozen.run.finalScreenshotKey).toBe("gen/abc/final.png");
    });

    it("keeps a run that recorded nothing capturable, with no media at all", () => {
        const noMedia: ClassifierCaseSource = {
            ...SOURCE,
            recording: undefined,
            finalScreenshotKey: undefined,
        };

        const { input, media } = rehydrateClassifierInput(throughDisk(noMedia));

        expect(media.recording).toBeUndefined();
        expect(media.finalScreenshotKey).toBeUndefined();
        expect(input.run.steps).toEqual(RUN.steps);
    });

    it("rejects a case whose recording key is blank rather than freezing an unfetchable address", () => {
        expect(() => serializeClassifierInput({ ...SOURCE, recording: { key: "", isOptimizedMp4: true } })).toThrow();
    });

    it("answers get_preview_env from the frozen names, through the live reader's own filter", async () => {
        const { input } = rehydrateClassifierInput(throughDisk(SOURCE));

        expect(await input.previewEnv?.getEnvVarNames()).toEqual(SOURCE.previewEnvNames);
        expect(await input.previewEnv?.getEnvVarNames("stripe")).toEqual(["STRIPE_SECRET_KEY"]);
        expect(await input.previewEnv?.getEnvVarNames("SENTRY")).toEqual([]);
    });

    it("offers no env listing at all when capture could not freeze the names in full", () => {
        const { input } = rehydrateClassifierInput(throughDisk({ ...SOURCE, previewEnvNames: undefined }));

        expect(input.previewEnv).toBeUndefined();
    });

    /**
     * An empty list is a real answer - a preview that configures nothing - and the tool renders it as decisive
     * evidence. Collapsing it into "not frozen" would silently downgrade that finding to an absent tool.
     */
    it("keeps an empty frozen list distinct from an absent one", async () => {
        const { input } = rehydrateClassifierInput(throughDisk({ ...SOURCE, previewEnvNames: [] }));

        expect(input.previewEnv).toBeDefined();
        expect(await input.previewEnv?.getEnvVarNames()).toEqual([]);
    });

    /**
     * The app-log window is the one frozen source whose EMPTY form carries meaning: the loader states it to the
     * model as the fact "the app emitted no matching error". So an empty window and an absent one must survive as
     * different cases - one replays that fact, the other omits `get_app_logs` entirely.
     */
    it("distinguishes a window that was queried and empty from one that was never captured", () => {
        const emptyWindow = throughDisk({
            ...SOURCE,
            appLogs: { namespace: "preview-acme-storefront-pr-1234", lines: [], windowTruncated: false },
        });
        const noWindow = throughDisk({ ...SOURCE, appLogs: undefined });

        expect(rehydrateClassifierInput(emptyWindow).appLogs?.lines).toEqual([]);
        expect(rehydrateClassifierInput(noWindow).appLogs).toBeUndefined();
    });

    it("preserves the frozen log window's lines and its own truncation flag", () => {
        const { appLogs } = rehydrateClassifierInput(throughDisk({ ...SOURCE, appLogs: TRUNCATED_WINDOW }));

        expect(appLogs).toEqual(TRUNCATED_WINDOW);
    });

    it("rejects a log line whose timestamp is not a nanosecond epoch, which the offset stamp would parse", () => {
        expect(() =>
            serializeClassifierInput({
                ...SOURCE,
                appLogs: {
                    namespace: "preview-acme-storefront-pr-1234",
                    lines: [{ timestampNs: "2026-08-05T12:00:00Z", line: "ERROR" }],
                    windowTruncated: false,
                },
            }),
        ).toThrow();
    });
});
