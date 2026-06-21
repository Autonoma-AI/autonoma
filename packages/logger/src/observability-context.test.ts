import { describe, expect, it } from "vitest";
import {
    extendObservabilityContext,
    flattenObservabilityContext,
    getObservabilityContext,
    pickObservabilityContext,
    withObservabilityContext,
} from "./observability-context";

describe("observability context", () => {
    it("returns an empty context outside any scope", () => {
        expect(getObservabilityContext()).toEqual({});
    });

    it("binds context to the async scope of the callback", async () => {
        await withObservabilityContext(
            { snapshot: { snapshotId: "snap-1" }, branch: { branchId: "br-1" } },
            async () => {
                expect(getObservabilityContext()).toMatchObject({
                    snapshot: { snapshotId: "snap-1" },
                    branch: { branchId: "br-1" },
                });
                await Promise.resolve();
                expect(getObservabilityContext()).toMatchObject({
                    snapshot: { snapshotId: "snap-1" },
                    branch: { branchId: "br-1" },
                });
            },
        );
        expect(getObservabilityContext()).toEqual({});
    });

    it("nested scopes deep-merge per group", () => {
        withObservabilityContext(
            { snapshot: { snapshotId: "outer" }, organization: { organizationId: "org-1" } },
            () => {
                withObservabilityContext(
                    {
                        snapshot: { snapshotId: "inner", headSha: "abc" },
                        refinementLoop: { loopId: "loop-1", triggeredBy: "diffs" },
                    },
                    () => {
                        const ctx = getObservabilityContext();
                        expect(ctx.snapshot).toEqual({ snapshotId: "inner", headSha: "abc" });
                        expect(ctx.organization).toEqual({ organizationId: "org-1" });
                        expect(ctx.refinementLoop).toEqual({ loopId: "loop-1", triggeredBy: "diffs" });
                    },
                );
                expect(getObservabilityContext().snapshot?.snapshotId).toBe("outer");
            },
        );
    });

    it("extendObservabilityContext deep-merges within a group", () => {
        withObservabilityContext({ snapshot: { snapshotId: "s1" } }, () => {
            // Each group is atomic: re-pass required fields when extending.
            extendObservabilityContext({
                snapshot: { snapshotId: "s1", headSha: "abc" },
                branch: { branchId: "br" },
            });
            expect(getObservabilityContext()).toMatchObject({
                snapshot: { snapshotId: "s1", headSha: "abc" },
                branch: { branchId: "br" },
            });
        });
    });

    it("extendObservabilityContext is a no-op outside a scope", () => {
        extendObservabilityContext({ snapshot: { snapshotId: "stray" } });
        expect(getObservabilityContext()).toEqual({});
    });

    it("flattenObservabilityContext produces a flat record for emit", () => {
        const flat = flattenObservabilityContext({
            snapshot: { snapshotId: "s1", headSha: "abc" },
            branch: { branchId: "br" },
            refinementLoop: { loopId: "loop", triggeredBy: "diffs" },
        });
        expect(flat).toEqual({
            snapshotId: "s1",
            headSha: "abc",
            branchId: "br",
            loopId: "loop",
            triggeredBy: "diffs",
        });
    });

    it("flattens the preview group, omitting an unset headRef", () => {
        expect(flattenObservabilityContext({ preview: { repo: "acme/web", headRef: "fix/login" } })).toEqual({
            repo: "acme/web",
            headRef: "fix/login",
        });
        expect(flattenObservabilityContext({ preview: { repo: "acme/web" } })).toEqual({ repo: "acme/web" });
    });

    it("pickObservabilityContext lifts a flat record into groups", () => {
        const result = pickObservabilityContext({
            snapshotId: "snap",
            iterationId: "iter",
            iterationNumber: 3,
            unrelatedKey: "drop me",
        });
        expect(result).toEqual({
            snapshot: { snapshotId: "snap" },
            refinementIteration: { iterationId: "iter", iterationNumber: 3 },
        });
    });

    it("pickObservabilityContext rejects an incomplete group", () => {
        // Refinement loop requires both loopId and triggeredBy; partial group is dropped.
        const result = pickObservabilityContext({ loopId: "loop" });
        expect(result).toEqual({});
    });

    it("pickObservabilityContext accepts a complete group", () => {
        const result = pickObservabilityContext({ loopId: "loop", triggeredBy: "diffs" });
        expect(result).toEqual({ refinementLoop: { loopId: "loop", triggeredBy: "diffs" } });
    });

    it("pickObservabilityContext accepts the already-nested shape", () => {
        const result = pickObservabilityContext({ snapshot: { snapshotId: "s" } });
        expect(result).toEqual({ snapshot: { snapshotId: "s" } });
    });

    it("pickObservabilityContext returns empty object for non-objects", () => {
        expect(pickObservabilityContext(null)).toEqual({});
        expect(pickObservabilityContext("string")).toEqual({});
        expect(pickObservabilityContext(42)).toEqual({});
    });
});
