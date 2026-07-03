import { expect } from "vitest";
import { CarryForwardSelector } from "../../src";
import { investigationDbSuite } from "../harness";

const EARLIER = new Date("2026-01-01T00:00:00Z");
const MIDDLE = new Date("2026-01-02T00:00:00Z");
const LATER = new Date("2026-01-03T00:00:00Z");

investigationDbSuite({
    name: "CarryForwardSelector",
    cases: (test) => {
        test("carries forward the tests that did not pass on the previous twin", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const prior = await harness.createTwinSnapshot(branchId, { createdAt: EARLIER });
            await harness.createShadowRun(prior, application.id, organizationId, "checkout-flow", "failed");
            await harness.createShadowRun(prior, application.id, organizationId, "login-flow", "success");
            // A selected-but-never-run test (workflow stopped mid-run) still counts as not-passing: re-run it.
            await harness.createShadowRun(prior, application.id, organizationId, "search-flow", "pending");
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current);

            expect([...carried].sort()).toEqual(["checkout-flow", "search-flow"]);
        });

        test("returns empty when the branch has no prior twin (its first investigation)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current);

            expect(carried).toEqual([]);
        });

        test("retires a test that passed in any run on the twin (e.g. a branch-scoped recipe fix)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const prior = await harness.createTwinSnapshot(branchId, { createdAt: EARLIER });
            // The same test failed its first run, then passed after a candidate fix - so it should NOT carry.
            await harness.createShadowRun(prior, application.id, organizationId, "checkout-flow", "failed");
            await harness.createShadowRun(prior, application.id, organizationId, "checkout-flow", "success");
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current);

            expect(carried).toEqual([]);
        });

        test("skips a superseded (cancelled) twin and falls back to the last twin that ran", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const completed = await harness.createTwinSnapshot(branchId, { createdAt: EARLIER });
            await harness.createShadowRun(completed, application.id, organizationId, "alpha-flow", "failed");
            // A newer twin that was superseded before finishing - its results are unreliable, so it is skipped.
            const superseded = await harness.createTwinSnapshot(branchId, { createdAt: MIDDLE, status: "cancelled" });
            await harness.createShadowRun(superseded, application.id, organizationId, "beta-flow", "failed");
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current);

            expect(carried).toEqual(["alpha-flow"]);
        });

        test("excludes tests already selected this snapshot, so nothing runs twice", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const prior = await harness.createTwinSnapshot(branchId, { createdAt: EARLIER });
            await harness.createShadowRun(prior, application.id, organizationId, "checkout-flow", "failed");
            await harness.createShadowRun(prior, application.id, organizationId, "profile-flow", "failed");
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            // checkout-flow was already picked by the diff this snapshot, so only profile-flow is carried.
            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current, ["checkout-flow"]);

            expect(carried).toEqual(["profile-flow"]);
        });

        test("ignores non-twin snapshots when finding the prior run", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            // A plain (diffs) snapshot with a shadow run but NO twin pairing must not be treated as a prior twin.
            const plain = await harness.db.branchSnapshot.create({
                data: { branchId, source: "WEBHOOK", createdAt: EARLIER },
                select: { id: true },
            });
            await harness.createShadowRun(plain.id, application.id, organizationId, "orphan-flow", "failed");
            const current = await harness.createTwinSnapshot(branchId, { createdAt: LATER });

            const carried = await new CarryForwardSelector(harness.db).selectCarriedSlugs(current);

            expect(carried).toEqual([]);
        });
    },
});
