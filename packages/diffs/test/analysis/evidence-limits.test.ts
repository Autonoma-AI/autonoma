import { describe, expect, it } from "vitest";
import { describeEvidenceLimits } from "../../src/analysis/classify/evidence-limits";
import type { ClassifierInput } from "../../src/analysis/classify/types";

/**
 * The note is the only thing that tells the model what a MISSING capability means for its verdict - the toolset
 * shows what is absent, never the consequence. Get the mapping wrong in the permissive direction and the model
 * is invited to assert a mechanism it had no way to observe.
 */

const previewScript = { runScript: async () => "" };
const loadAppLogs = async () => "";

/** A run that can LIST the preview's env vars but cannot reach the pod - what every replayed eval case is. */
const ENV_LISTING_ONLY: Pick<ClassifierInput, "previewEnv" | "previewScript" | "loadAppLogs"> = {
    previewEnv: { getEnvVarNames: async () => ["STRIPE_SECRET_KEY"] },
};

describe("describeEvidenceLimits", () => {
    it("says nothing when the run can both query the backend and read the logs", () => {
        expect(describeEvidenceLimits({ previewScript, loadAppLogs })).toBeUndefined();
    });

    it("declares unseen mechanisms unprovable when neither the backend nor the logs are reachable", () => {
        const note = describeEvidenceLimits({});

        expect(note).toContain("cannot read this app's server logs OR query its backend");
        expect(note).toContain("UNPROVABLE");
    });

    it("points at the backend as the substitute when only the logs are unreadable", () => {
        expect(describeEvidenceLimits({ previewScript })).toContain(
            "cannot read this app's server logs on this run, but you CAN query its backend",
        );
    });

    it("points at the logs as the substitute when only the backend is unreachable", () => {
        expect(describeEvidenceLimits({ loadAppLogs })).toContain(
            "cannot query this app's backend on this run, but you CAN read its server logs",
        );
    });

    /** Backend reachability is the SCRIPT capability alone; listing names proves nothing about the backend. */
    it("treats a run that can only list env vars exactly like one with no preview at all", () => {
        expect(describeEvidenceLimits(ENV_LISTING_ONLY)).toBe(describeEvidenceLimits({}));
    });
});
