import { describe, expect, it } from "vitest";
import { PriorRuns } from "../../src/db/prior-runs";

describe("formatPriorRunsBaseline", () => {
    it("flags a never-run test as unproven", () => {
        const text = PriorRuns.formatBaseline({ everPassed: false, totalRecent: 0, successCount: 0, recent: [] });
        expect(text).toContain("NEVER been executed");
        expect(text).toContain("UNPROVEN");
    });

    it("reports an established baseline when the test has passed", () => {
        const text = PriorRuns.formatBaseline({
            everPassed: true,
            totalRecent: 3,
            successCount: 1,
            mostRecentSuccessDay: "2026-06-05",
            recent: [
                { day: "2026-06-10", status: "failed" },
                { day: "2026-06-05", status: "success" },
            ],
        });
        expect(text).toContain("ever passed: YES");
        expect(text).toContain("most recent success on 2026-06-05");
        expect(text).toContain("2026-06-10:failed");
    });

    it("reports no baseline (and the failure kind) when it has only ever failed", () => {
        const text = PriorRuns.formatBaseline({
            everPassed: false,
            totalRecent: 2,
            successCount: 0,
            recent: [{ day: "2026-06-02", status: "failed", failureKind: "engine_error" }],
        });
        expect(text).toContain("ever passed: NO");
        expect(text).toContain("2026-06-02:failed(engine_error)");
    });
});
