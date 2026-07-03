import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "investigation report",
    seed: async ({ harness }) => {
        const application = await harness.services.applications.createApplication({
            name: "Report App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });
        const branch = await harness.db.branch.create({
            data: { name: "feature/report", applicationId: application.id, organizationId: harness.organizationId },
        });
        return { application, branch };
    },
    cases: (test) => {
        // Each case makes its own PR snapshot: the suites share one DB with no per-test truncation, so a shared
        // snapshot would leak an InvestigationReport from one case into another's "no report" assertion.
        test("resolves a legacy report keyed directly to the PR snapshot (pre-#1204)", async ({
            harness,
            seedResult: { branch },
        }) => {
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "legacy-sha" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prSnapshot.id,
                    organizationId: harness.organizationId,
                    s3Key: "investigation/report-app/legacy.md",
                    testCount: 3,
                    clientBugCount: 1,
                },
            });

            const report = await harness.services.branches.getInvestigationReport(
                prSnapshot.id,
                harness.organizationId,
            );
            expect(report).not.toBeUndefined();
            expect(report?.testCount).toBe(3);
            expect(report?.clientBugCount).toBe(1);
        });

        test("resolves a twin report via the investigationParent FK (post-#1204)", async ({
            harness,
            seedResult: { branch },
        }) => {
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "twin-sha" },
            });
            const twin = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH" },
            });
            await harness.db.branchSnapshot.update({
                where: { id: prSnapshot.id },
                data: { investigationSnapshotId: twin.id },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: twin.id,
                    organizationId: harness.organizationId,
                    s3Key: "investigation/report-app/twin.md",
                    testCount: 5,
                    clientBugCount: 0,
                },
            });

            const report = await harness.services.branches.getInvestigationReport(
                prSnapshot.id,
                harness.organizationId,
            );
            expect(report?.testCount).toBe(5);
        });

        test("returns undefined when no report exists for the snapshot", async ({
            harness,
            seedResult: { branch },
        }) => {
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "none-sha" },
            });
            const report = await harness.services.branches.getInvestigationReport(
                prSnapshot.id,
                harness.organizationId,
            );
            expect(report).toBeUndefined();
        });

        test("batched presence resolves direct + twin reports keyed to the PR snapshot, and skips ones without", async ({
            harness,
            seedResult: { branch },
        }) => {
            // PR A: a legacy report keyed directly to the PR snapshot.
            const prA = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-a" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prA.id,
                    organizationId: harness.organizationId,
                    s3Key: "investigation/report-app/batch-a.md",
                    testCount: 2,
                    clientBugCount: 2,
                },
            });

            // PR B: a report on the detached twin, reachable only via the investigationParent FK.
            const prB = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-b" },
            });
            const twinB = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH" },
            });
            await harness.db.branchSnapshot.update({
                where: { id: prB.id },
                data: { investigationSnapshotId: twinB.id },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: twinB.id,
                    organizationId: harness.organizationId,
                    s3Key: "investigation/report-app/batch-b.md",
                    testCount: 4,
                    clientBugCount: 0,
                },
            });

            // PR C: no report at all.
            const prC = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-c" },
            });

            const presence = await harness.services.branches.getInvestigationReportsForSnapshots(
                [prA.id, prB.id, prC.id],
                harness.organizationId,
            );

            const byId = new Map(presence.map((entry) => [entry.snapshotId, entry]));
            expect(byId.size).toBe(2);
            expect(byId.get(prA.id)).toMatchObject({ clientBugCount: 2, status: "completed" });
            // The twin's report is keyed back to the PR snapshot the UI routes on, not the twin id.
            expect(byId.get(prB.id)).toMatchObject({ clientBugCount: 0, status: "completed" });
            expect(byId.has(twinB.id)).toBe(false);
            expect(byId.has(prC.id)).toBe(false);
        });
    },
});
