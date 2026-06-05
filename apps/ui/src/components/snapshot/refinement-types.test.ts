import { describe, expect, it } from "vitest";
import { iterationVisualState, type RefinementIteration } from "./refinement-types";

function iteration(input: Partial<RefinementIteration>): RefinementIteration {
    return {
        id: "iteration-1",
        number: 1,
        status: "completed",
        startedAt: new Date("2026-01-01T10:00:00Z"),
        finishedAt: new Date("2026-01-01T10:05:00Z"),
        inputs: [],
        outcomes: {
            validated: [],
            failedAtGeneration: [],
            failedAtReplay: [],
            awaiting: [],
        },
        actions: [],
        ...input,
    } as RefinementIteration;
}

describe("iterationVisualState", () => {
    it("shows the latest iteration in an errored loop as failed", () => {
        expect(
            iterationVisualState(iteration({ status: "running", finishedAt: undefined }), {
                loopStatus: "error",
                isLast: true,
            }),
        ).toBe("failed");
    });

    it("keeps non-latest errored loop iterations based on their own status", () => {
        expect(
            iterationVisualState(iteration({ status: "running", finishedAt: undefined }), {
                loopStatus: "error",
                isLast: false,
            }),
        ).toBe("running");
    });
});
