import { ApplicationArchitecture, measureQueries } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/**
 * Performance budgets for the database queries issued when the pull-request pages load.
 *
 * These assert the NUMBER of SQL statements a procedure issues, not wall-clock time, because query
 * count is deterministic (machine-independent, no flakiness on CI runners) and is exactly the thing
 * that regresses into slowness: per-item round-trips (N+1). The budgets run against the real
 * Testcontainers/CI Postgres the rest of the integration suite uses, so they need no special setup.
 *
 * When a budget breaks: do not just bump the number. A higher count almost always means a query was
 * added inside a loop or a `Promise.all(items.map(...))`. Batch it into a single bulk query first.
 * Only raise a budget when the extra queries are genuinely unavoidable, and say why in the diff.
 */

// branches.detailByPr is the PR detail route loader - a single branch lookup. It must stay flat
// (independent of how much data the branch has), so the ceiling is tiny.
const DETAIL_BY_PR_BUDGET = 2;

// A single lean snapshotDetail (the payload the PR overview card fans out across every snapshot).
// Measured constant cost is ~30 SQL statements (the nested-include reads expand to several
// statements each under the pg driver adapter); the value does NOT grow with the number of tests in
// the snapshot. The open-bug-count read lets the checkpoint summary separate real app bugs from
// execution/quarantine state (countOpenBugsBySnapshot resolves its generationReview/runReview
// relation chains as a couple of statements). Budget is current + headroom: a coarse net. The slope
// assertion below is the precise N+1 guard. This cost is constant per call, but the PR overview
// card multiplies it by the snapshot count.
const SNAPSHOT_DETAIL_LEAN_BUDGET = 35;

// Marginal DB cost snapshotHistory is allowed to spend per additional snapshot in the branch. This
// is the N+1 guard: the assertion measures the slope (queries for many snapshots minus queries for
// few), so constant per-call overhead cancels out and only per-snapshot growth is bounded. Measured
// baseline is 6/snapshot today - snapshotHistory already fans `summarizeChangesForSnapshot` out per
// snapshot. This caps that at its current cost so it cannot get worse without someone noticing.
const SNAPSHOT_HISTORY_PER_SNAPSHOT_BUDGET = 7;

apiTestSuite({
    name: "pull-requests query budgets",
    cases: (test) => {
        test("branches.detailByPr stays flat regardless of branch data", async ({ harness }) => {
            const { applicationId, prNumber } = await seedPullRequest(harness, {
                snapshotCount: 4,
                testsPerSnapshot: 3,
            });

            const { queryCount } = await measureQueries(() =>
                harness.request().branches.detailByPr({ applicationId, prNumber }),
            );

            expect(queryCount).toBeLessThanOrEqual(DETAIL_BY_PR_BUDGET);
        });

        test("branches.snapshotDetail (lean) stays under budget and does not N+1 over test cases", async ({
            harness,
        }) => {
            const small = await seedPullRequest(harness, { snapshotCount: 1, testsPerSnapshot: 2 });
            const large = await seedPullRequest(harness, { snapshotCount: 1, testsPerSnapshot: 8 });

            const { queryCount: smallCount } = await measureQueries(() =>
                harness.request().branches.snapshotDetail({ snapshotId: small.latestSnapshotId }),
            );
            const { queryCount: largeCount } = await measureQueries(() =>
                harness.request().branches.snapshotDetail({ snapshotId: large.latestSnapshotId }),
            );

            expect(largeCount).toBeLessThanOrEqual(SNAPSHOT_DETAIL_LEAN_BUDGET);
            // 4x the test cases must not meaningfully raise the query count - the snapshot's tests are
            // loaded in bulk, not one query per test. A small slack absorbs query-planner variance.
            expect(largeCount).toBeLessThanOrEqual(smallCount + 2);
        });

        test("branches.snapshotDetail full payload costs more than lean (the trim is real)", async ({ harness }) => {
            const { latestSnapshotId } = await seedPullRequest(harness, { snapshotCount: 1, testsPerSnapshot: 3 });

            const { queryCount: leanCount } = await measureQueries(() =>
                harness.request().branches.snapshotDetail({ snapshotId: latestSnapshotId }),
            );
            const { queryCount: fullCount } = await measureQueries(() =>
                harness
                    .request()
                    .branches.snapshotDetail({ snapshotId: latestSnapshotId, includeRefinementLoop: true }),
            );

            // The lean path the PR overview card uses skips the refinement-loop query. If these ever
            // match, the opt-out regressed and the card is paying for data it never renders.
            expect(leanCount).toBeLessThan(fullCount);
        });

        test("branches.snapshotHistory does not N+1 over snapshots", async ({ harness }) => {
            const fewSnapshots = 2;
            const manySnapshots = 8;
            const few = await seedPullRequest(harness, { snapshotCount: fewSnapshots, testsPerSnapshot: 2 });
            const many = await seedPullRequest(harness, { snapshotCount: manySnapshots, testsPerSnapshot: 2 });

            const { queryCount: fewCount } = await measureQueries(() =>
                harness.request().branches.snapshotHistory({ branchId: few.branchId }),
            );
            const { queryCount: manyCount } = await measureQueries(() =>
                harness.request().branches.snapshotHistory({ branchId: many.branchId }),
            );

            const marginalPerSnapshot = (manyCount - fewCount) / (manySnapshots - fewSnapshots);
            expect(marginalPerSnapshot).toBeLessThanOrEqual(SNAPSHOT_HISTORY_PER_SNAPSHOT_BUDGET);
        });
    },
});

/**
 * Seeds a branch with a PR and a chain of snapshots, each with a completed diffs job and a set of
 * executed tests (test case + assignment + run). Mirrors the shape the PR pages read on load.
 */
async function seedPullRequest(
    harness: APITestHarness,
    input: { snapshotCount: number; testsPerSnapshot: number },
): Promise<{
    applicationId: string;
    prNumber: number;
    branchId: string;
    latestSnapshotId: string;
}> {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const application = await harness.services.applications.createApplication({
        name: `PR Budget ${uniqueSuffix}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });

    const folder = await harness.db.folder.create({
        data: { name: "Default", applicationId: application.id, organizationId: harness.organizationId },
    });

    const prNumber = prNumberFromSuffix(uniqueSuffix);
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/pr-budget-${uniqueSuffix}`,
            applicationId: application.id,
            organizationId: harness.organizationId,
            prInfo: { create: { applicationId: application.id, prNumber } },
        },
    });

    let prevSnapshotId: string | undefined;
    let latestSnapshotId = "";
    for (let snapshotIndex = 0; snapshotIndex < input.snapshotCount; snapshotIndex += 1) {
        const snapshot = await harness.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "GITHUB_PUSH",
                status: "active",
                baseSha: `base-${snapshotIndex}`,
                headSha: `head-${snapshotIndex}`,
                prevSnapshotId,
            },
        });
        await harness.db.diffsJob.create({
            data: { snapshotId: snapshot.id, status: "completed", organizationId: harness.organizationId },
        });

        for (let testIndex = 0; testIndex < input.testsPerSnapshot; testIndex += 1) {
            const slug = `test-${uniqueSuffix}-${snapshotIndex}-${testIndex}`;
            const testCase = await harness.db.testCase.create({
                data: {
                    name: `Test ${snapshotIndex}.${testIndex}`,
                    slug,
                    applicationId: application.id,
                    folderId: folder.id,
                    organizationId: harness.organizationId,
                },
            });
            const assignment = await harness.db.testCaseAssignment.create({
                data: { snapshotId: snapshot.id, testCaseId: testCase.id },
            });
            await harness.db.run.create({
                data: {
                    assignmentId: assignment.id,
                    status: "success",
                    startedAt: new Date("2026-01-01T10:00:00Z"),
                    createdAt: new Date("2026-01-01T10:00:00Z"),
                    organizationId: harness.organizationId,
                },
            });
        }

        prevSnapshotId = snapshot.id;
        latestSnapshotId = snapshot.id;
    }

    return { applicationId: application.id, prNumber, branchId: branch.id, latestSnapshotId };
}

/** Derives a stable, positive PR number from the fixture's unique suffix to avoid collisions. */
function prNumberFromSuffix(suffix: string): number {
    return (Number.parseInt(suffix, 16) % 90_000) + 1;
}
