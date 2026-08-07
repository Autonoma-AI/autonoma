import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { SnapshotDependencyManifestPinner } from "../src/codebase/pin-dependency-manifest";
import { diffJobContextSuite } from "./harness";

let seq = 0;
function uniqueInt(): number {
    seq += 1;
    return 100_000 + seq;
}

/**
 * Build a deploy-resolved previewkit config carrying the given per-repository
 * deploy SHAs. Stored verbatim as `resolvedConfig` JSON; the pinner re-parses
 * it and fills the remaining defaults, so only the fields the pinner reads
 * need to be present.
 */
function configWithDeps(deps: Array<{ repo: string; sha?: string }>): Record<string, unknown> {
    return {
        version: 2,
        apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        repositories: deps,
    };
}

/** Reload a snapshot's pinned map straight from the column (the pin's only side effect). */
async function readPin(db: PrismaClient, snapshotId: string): Promise<unknown> {
    const reloaded = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { pinnedDependencyShas: true },
    });
    return reloaded.pinnedDependencyShas;
}

interface SeededPinTarget {
    snapshotId: string;
    githubRepositoryId: number;
    prNumber: number;
    headSha: string;
    namespace: string;
    repoFullName: string;
}

/**
 * Seed the minimal graph the pinner reads: an application carrying a GitHub repo
 * id, a PR branch with `prInfo`, and a snapshot at `headSha`. Returns the
 * coordinates so the test can later create the headSha-exact PreviewkitEnvironment.
 */
async function seedPinTarget(
    db: PrismaClient,
    organizationId: string,
    opts: { headSha: string; withPr?: boolean },
): Promise<SeededPinTarget> {
    const githubRepositoryId = uniqueInt();
    const prNumber = uniqueInt();
    const slug = `pin-app-${uniqueInt()}`;
    const application = await db.application.create({
        data: { name: slug, slug, organizationId, architecture: "WEB", githubRepositoryId },
    });
    const branch = await db.branch.create({
        data: { name: `branch-${uniqueInt()}`, organizationId, applicationId: application.id },
    });
    if (opts.withPr !== false) {
        await db.featureBranchInfo.create({
            data: { branchId: branch.id, applicationId: application.id, prNumber },
        });
    }
    const snapshot = await db.branchSnapshot.create({
        data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: opts.headSha },
    });
    return {
        snapshotId: snapshot.id,
        githubRepositoryId,
        prNumber,
        headSha: opts.headSha,
        namespace: `preview-pin-${uniqueInt()}`,
        repoFullName: `acme/${slug}`,
    };
}

async function createEnvironment(
    db: PrismaClient,
    organizationId: string,
    target: SeededPinTarget,
    resolvedConfig: Record<string, unknown>,
    overrides?: { headSha?: string },
): Promise<void> {
    await db.previewkitEnvironment.create({
        data: {
            namespace: target.namespace,
            repoFullName: target.repoFullName,
            prNumber: target.prNumber,
            headSha: overrides?.headSha ?? target.headSha,
            headRef: "refs/pull/1/head",
            githubRepositoryId: target.githubRepositoryId,
            organizationId,
            status: "ready",
            resolvedConfig,
        },
    });
}

diffJobContextSuite({
    name: "SnapshotDependencyManifestPinner",
    cases: (test) => {
        test("pins the per-dependency SHA map from the headSha-exact environment", async ({ harness, seedResult }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "head-exact-1" });
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([
                    { repo: "acme/api", sha: "api-sha-aaa" },
                    { repo: "acme/worker", sha: "worker-sha-bbb" },
                ]),
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({
                "acme/api": "api-sha-aaa",
                "acme/worker": "worker-sha-bbb",
            });
        });

        test("keys the pin by the lowercased repo full name (case-canonical repo identity)", async ({
            harness,
            seedResult,
        }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "head-case" });
            // Repo identity is case-insensitive elsewhere in previewkit, so a mixed-case config name pins lowercased.
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "CoderHouse/Core-App-Backend", sha: "cased-sha" }]),
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({
                "coderhouse/core-app-backend": "cased-sha",
            });
        });

        test("pins only dependencies that recorded a SHA (partial manifest)", async ({ harness, seedResult }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "head-partial" });
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "acme/api", sha: "api-sha-only" }, { repo: "acme/skipped" }]),
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({ "acme/api": "api-sha-only" });
        });

        test("degrades to an empty pin when no environment matches the exact headSha", async ({
            harness,
            seedResult,
        }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "snapshot-head" });
            // The environment already redeployed past this commit: its headSha moved
            // on, so the headSha-exact lookup must miss rather than pin newer code.
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "acme/api", sha: "newer-sha" }]),
                { headSha: "redeployed-head" },
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            // Pinned-empty (`{}`), not unpinned (`null`): the snapshot is settled.
            expect(await readPin(harness.db, target.snapshotId)).toEqual({});
        });

        test("degrades to an empty pin when no previewkit environment exists at all", async ({
            harness,
            seedResult,
        }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "no-env-head" });

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({});
        });

        test("degrades to an empty pin for a non-PR snapshot (no prNumber)", async ({ harness, seedResult }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, {
                headSha: "main-head",
                withPr: false,
            });
            // An environment with this repo+headSha exists, but without a prNumber on
            // the snapshot there is nothing to resolve against - pin empty, no error.
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "acme/api", sha: "should-not-pin" }]),
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({});
        });

        test("a later redeploy does not change an already-pinned snapshot (stability)", async ({
            harness,
            seedResult,
        }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "head-stable" });
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "acme/api", sha: "original-sha" }]),
            );

            const pinner = new SnapshotDependencyManifestPinner(harness.db);
            await pinner.ensurePinned(target.snapshotId);
            expect(await readPin(harness.db, target.snapshotId)).toEqual({ "acme/api": "original-sha" });

            // Simulate a redeploy of the same PR: previewkit overwrites the
            // environment's resolvedConfig (and could move its headSha) in place.
            await harness.db.previewkitEnvironment.update({
                where: { namespace: target.namespace },
                data: { resolvedConfig: configWithDeps([{ repo: "acme/api", sha: "redeployed-sha" }]) },
            });

            await pinner.ensurePinned(target.snapshotId);

            // The in-flight snapshot keeps grounding against the code that was live
            // when it first grounded - the redeploy can not corrupt it.
            expect(await readPin(harness.db, target.snapshotId)).toEqual({ "acme/api": "original-sha" });
        });

        test("leaves a legacy alias-keyed pin untouched (idempotence)", async ({ harness, seedResult }) => {
            const target = await seedPinTarget(harness.db, seedResult.organizationId, { headSha: "head-alias" });
            // A legacy alias-keyed pin (retired multirepo config); an already-pinned snapshot is never re-resolved,
            // so it is left verbatim, not rewritten under the new owner/repo key space.
            await harness.db.branchSnapshot.update({
                where: { id: target.snapshotId },
                data: { pinnedDependencyShas: { be: "alias-keyed-sha" } },
            });
            await createEnvironment(
                harness.db,
                seedResult.organizationId,
                target,
                configWithDeps([{ repo: "acme/be", sha: "repo-keyed-sha" }]),
            );

            await new SnapshotDependencyManifestPinner(harness.db).ensurePinned(target.snapshotId);

            expect(await readPin(harness.db, target.snapshotId)).toEqual({ be: "alias-keyed-sha" });
        });
    },
});
