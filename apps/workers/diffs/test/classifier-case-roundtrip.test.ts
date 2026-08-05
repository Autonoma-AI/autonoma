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
    productionCapabilities: { previewEnv: true, previewScript: true, appLogs: false },
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
});
