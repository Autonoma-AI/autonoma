import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { resolveDependencyCheckouts } from "../src/codebase/resolve-dependencies";
import { diffJobContextSuite } from "./harness";

let seq = 0;
function uniqueInt(): number {
    seq += 1;
    return 300_000 + seq;
}

/** Create a branch under the seeded org and return its id. */
async function seedBranch(db: PrismaClient, organizationId: string): Promise<string> {
    const slug = `dep-app-${uniqueInt()}`;
    const application = await db.application.create({
        data: { name: slug, slug, organizationId, architecture: "WEB", githubRepositoryId: uniqueInt() },
    });
    const branch = await db.branch.create({
        data: { name: `branch-${uniqueInt()}`, organizationId, applicationId: application.id },
    });
    return branch.id;
}

/** Create a snapshot carrying a pinned dependency-sha map, chained onto an optional previous snapshot. */
async function seedSnapshot(
    db: PrismaClient,
    branchId: string,
    opts: { pinned?: Record<string, string>; prevSnapshotId?: string },
): Promise<string> {
    const snapshot = await db.branchSnapshot.create({
        data: {
            branchId,
            source: "GITHUB_PUSH",
            headSha: `head-${uniqueInt()}`,
            pinnedDependencyShas: opts.pinned ?? undefined,
            prevSnapshotId: opts.prevSnapshotId,
        },
    });
    return snapshot.id;
}

diffJobContextSuite({
    name: "resolveDependencyCheckouts",
    cases: (test) => {
        test("clones each pinned dep at its current sha with the previous snapshot's sha as base", async ({
            harness,
            seedResult,
        }) => {
            const branchId = await seedBranch(harness.db, seedResult.organizationId);
            const prev = await seedSnapshot(harness.db, branchId, {
                pinned: { "acme/api": "api-old", "acme/worker": "worker-old" },
            });
            const current = await seedSnapshot(harness.db, branchId, {
                pinned: { "acme/api": "api-new", "acme/worker": "worker-new" },
                prevSnapshotId: prev,
            });

            const result = await resolveDependencyCheckouts(harness.db, current);

            expect(result.unavailable).toEqual([]);
            expect(result.dependencies).toEqual(
                expect.arrayContaining([
                    { name: "acme/api", commitSha: "api-new", baseSha: "api-old" },
                    { name: "acme/worker", commitSha: "worker-new", baseSha: "worker-old" },
                ]),
            );
        });

        test("a dependency with no previous pin is read-only (no base)", async ({ harness, seedResult }) => {
            const branchId = await seedBranch(harness.db, seedResult.organizationId);
            const current = await seedSnapshot(harness.db, branchId, { pinned: { "acme/api": "api-first" } });

            const result = await resolveDependencyCheckouts(harness.db, current);

            expect(result.dependencies).toEqual([{ name: "acme/api", commitSha: "api-first", baseSha: undefined }]);
        });

        test("walks past an ancestor that did not pin the dep to the most recent one that did", async ({
            harness,
            seedResult,
        }) => {
            const branchId = await seedBranch(harness.db, seedResult.organizationId);
            const oldest = await seedSnapshot(harness.db, branchId, { pinned: { "acme/api": "api-oldest" } });
            const middle = await seedSnapshot(harness.db, branchId, { pinned: {}, prevSnapshotId: oldest });
            const current = await seedSnapshot(harness.db, branchId, {
                pinned: { "acme/api": "api-current" },
                prevSnapshotId: middle,
            });

            const result = await resolveDependencyCheckouts(harness.db, current);

            expect(result.dependencies).toEqual([
                { name: "acme/api", commitSha: "api-current", baseSha: "api-oldest" },
            ]);
        });

        test("skips legacy alias-keyed pins (a key without a slash is not a resolvable repo)", async ({
            harness,
            seedResult,
        }) => {
            const branchId = await seedBranch(harness.db, seedResult.organizationId);
            const current = await seedSnapshot(harness.db, branchId, {
                pinned: { be: "alias-sha", "acme/api": "api-sha" },
            });

            const result = await resolveDependencyCheckouts(harness.db, current);

            expect(result.dependencies).toEqual([{ name: "acme/api", commitSha: "api-sha", baseSha: undefined }]);
        });

        test("an empty pin yields a single-repo checkout (no dependencies)", async ({ harness, seedResult }) => {
            const branchId = await seedBranch(harness.db, seedResult.organizationId);
            const current = await seedSnapshot(harness.db, branchId, { pinned: {} });

            const result = await resolveDependencyCheckouts(harness.db, current);

            expect(result).toEqual({ dependencies: [], unavailable: [] });
        });
    },
});
