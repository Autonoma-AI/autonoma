import { describe, expect, it } from "vitest";
import { authoritativeSnapshotHealth } from "../src/authoritative";

/**
 * `health` is rendered beside the badge (the snapshot report header) and gated on directly (the main-branch rail
 * shows "Healthy" for `health === "healthy"`), so these pin that it never claims more than the badge does.
 */
describe("authoritativeSnapshotHealth", () => {
    it("reports a confirmed, bug-free run as healthy", () => {
        expect(
            authoritativeSnapshotHealth({ jobStatus: "completed", findingBuckets: { bug: 0, passed: 4, coverage: 0 } }),
        ).toBe("healthy");
    });

    it("does not report a run that confirmed nothing as healthy", () => {
        // Every selected test was blocked before it reached the app. Claiming health here is the whole defect:
        // surfaces that gate on "healthy" would announce the app was checked when nothing was.
        expect(
            authoritativeSnapshotHealth({ jobStatus: "completed", findingBuckets: { bug: 0, passed: 0, coverage: 7 } }),
        ).toBe("unknown");
    });

    it("does not report a run that selected nothing as healthy", () => {
        expect(
            authoritativeSnapshotHealth({ jobStatus: "completed", findingBuckets: { bug: 0, passed: 0, coverage: 0 } }),
        ).toBe("unknown");
    });

    it("reports an open bug as critical", () => {
        expect(
            authoritativeSnapshotHealth({
                jobStatus: "completed",
                findingBuckets: { bug: 0, passed: 3, coverage: 0 },
                bugCount: 2,
            }),
        ).toBe("critical");
    });

    it("reports a failed pipeline as critical and an in-flight run as running", () => {
        expect(authoritativeSnapshotHealth({ jobStatus: "failed" })).toBe("critical");
        expect(authoritativeSnapshotHealth({ jobStatus: "running" })).toBe("running");
        // Completed but report-less: the Reporter has not landed yet, so there is nothing to judge.
        expect(authoritativeSnapshotHealth({ jobStatus: "completed" })).toBe("running");
    });
});
