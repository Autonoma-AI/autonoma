import { expect } from "vitest";
import { aggregateSnapshotHealth } from "../src/health";
import { getCheckpointSummaries } from "../src/index";
import { countOpenBugsBySnapshot } from "../src/open-bugs";
import { buildCheckpointSummary } from "../src/presentation";
import type { CheckpointHarness } from "./harness";
import { checkpointSuite } from "./harness";

// Seeds one snapshot covering every outcome bucket plus an open application bug
// (which also drives the engine-vs-app failing attribution).
async function seedMixedSnapshot(harness: CheckpointHarness) {
    const organizationId = await harness.createOrg();
    const { applicationId, snapshotId, folderId } = await harness.createSnapshot(organizationId);
    const at = new Date("2026-01-01T10:00:00Z");

    const make = (name: string) =>
        harness.createAssignment({ organizationId, applicationId, folderId, snapshotId, name });

    const passing = await make("Passing check");
    const failing = await make("Failing check");
    const setup = await make("Setup check");
    const running = await make("Running check");

    await harness.createRun({ organizationId, assignmentId: passing.id, status: "success", at });

    const failedRun = await harness.createRun({ organizationId, assignmentId: failing.id, status: "failed", at });
    await harness.fileOpenBug({ organizationId, applicationId, runId: failedRun.id });

    await harness.createRun({
        organizationId,
        assignmentId: setup.id,
        status: "failed",
        at,
        failure: { kind: "scenario_setup", message: "Environment never came up." },
    });
    await harness.createRun({ organizationId, assignmentId: running.id, status: "running", at });

    return { snapshotId };
}

checkpointSuite({
    name: "getCheckpointSummaries",
    cases: (test) => {
        test("derives counts, failing attribution, open bugs, and execution state from one snapshot", async ({
            harness,
        }) => {
            const { snapshotId } = await seedMixedSnapshot(harness);

            const summaries = await getCheckpointSummaries(harness.db, [{ id: snapshotId, status: "active" }]);
            const summary = summaries.get(snapshotId);

            expect(summary).toBeDefined();
            expect(summary?.testCounts).toEqual({
                assigned: 4,
                run: 4,
                passed: 1,
                failed: 1,
                setupFailed: 1,
                running: 1,
                notRun: 0,
            });
            // The failing test carries an application_bug issue, so it attributes to app.
            expect(summary?.failingByKind).toEqual({ engine: 0, app: 1 });
            expect(summary?.openBugCount).toBe(1);
            expect(summary?.executionState).toBe("failed");
            // The open bug takes presentation precedence over the failing-tests label.
            expect(summary?.tone).toBe("critical");
            expect(summary?.label).toBe("1 bug");
        });

        test("getCheckpointSummaries equals the explicit aggregate + bug-count + build path", async ({ harness }) => {
            const { snapshotId } = await seedMixedSnapshot(harness);
            const snapshots = [{ id: snapshotId, status: "active" }];

            // The path the API list views use.
            const [healthBySnapshot, openBugCountBySnapshot] = await Promise.all([
                aggregateSnapshotHealth(harness.db, snapshots),
                countOpenBugsBySnapshot(harness.db, [snapshotId]),
            ]);
            const health = healthBySnapshot.get(snapshotId);
            if (health == null) throw new Error("expected health for seeded snapshot");
            const viaApiPath = buildCheckpointSummary({
                snapshotStatus: "active",
                counts: health.counts,
                openBugCount: openBugCountBySnapshot.get(snapshotId) ?? 0,
                failingByKind: health.failingByKind,
            });

            // The path the GitHub PR commenter uses.
            const viaCommenterPath = (await getCheckpointSummaries(harness.db, snapshots)).get(snapshotId);

            expect(viaCommenterPath).toEqual(viaApiPath);
        });

        test("reports 'No runs' (neutral) for a snapshot with assignments but no runs", async ({ harness }) => {
            const organizationId = await harness.createOrg();
            const { applicationId, snapshotId, folderId } = await harness.createSnapshot(organizationId);
            await harness.createAssignment({ organizationId, applicationId, folderId, snapshotId, name: "Idle check" });

            const summary = (await getCheckpointSummaries(harness.db, [{ id: snapshotId, status: "active" }])).get(
                snapshotId,
            );

            expect(summary?.executionState).toBe("not_started");
            expect(summary?.tone).toBe("neutral");
            expect(summary?.label).toBe("No runs");
            expect(summary?.testCounts.assigned).toBe(1);
            expect(summary?.testCounts.run).toBe(0);
        });
    },
});
