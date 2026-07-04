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
        test("resolves an island report keyed directly to the PR snapshot (pre-#1204)", async ({
            harness,
            seedResult: { branch },
        }) => {
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "direct-sha" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prSnapshot.id,
                    organizationId: harness.organizationId,
                    appSlug: "report-app",
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

        test("resolves an island report on the twin via the investigationParent FK (post-#1204)", async ({
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
                    appSlug: "report-app",
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

        test("hides a completed report with no island header (appSlug null) - unrenderable until backfilled", async ({
            harness,
            seedResult: { branch },
        }) => {
            // A pre-island report: it has an S3 markdown key but no denormalized header, so the report page can't
            // render it. The entry point must NOT surface it (this was the "click -> empty page" bug).
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "legacy-hidden-sha" },
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
            expect(report).toBeUndefined();
        });

        test("surfaces a running report even before it has an island header", async ({
            harness,
            seedResult: { branch },
        }) => {
            const prSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "running-sha" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prSnapshot.id,
                    organizationId: harness.organizationId,
                    status: "running",
                    stage: "running",
                    testCount: 0,
                    clientBugCount: 0,
                },
            });

            const report = await harness.services.branches.getInvestigationReport(
                prSnapshot.id,
                harness.organizationId,
            );
            expect(report?.status).toBe("running");
        });

        test("batched presence resolves island reports keyed to the PR snapshot, skipping legacy/none", async ({
            harness,
            seedResult: { branch },
        }) => {
            // PR A: an island report keyed directly to the PR snapshot.
            const prA = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-a" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prA.id,
                    organizationId: harness.organizationId,
                    appSlug: "report-app",
                    testCount: 2,
                    clientBugCount: 2,
                },
            });
            // A scenario + an environment failure make PR A "warning"-level; a passed finding must NOT count.
            await harness.db.investigationFinding.createMany({
                data: [
                    {
                        reportSnapshotId: prA.id,
                        organizationId: harness.organizationId,
                        findingKey: "a1",
                        slug: "a1",
                        category: "scenario_issue",
                        headline: "seed",
                        displayOrder: 0,
                    },
                    {
                        reportSnapshotId: prA.id,
                        organizationId: harness.organizationId,
                        findingKey: "a2",
                        slug: "a2",
                        category: "environment_failure",
                        headline: "env",
                        displayOrder: 1,
                    },
                    {
                        reportSnapshotId: prA.id,
                        organizationId: harness.organizationId,
                        findingKey: "a3",
                        slug: "a3",
                        category: "passed",
                        headline: "ok",
                        displayOrder: 2,
                    },
                ],
            });

            // PR B: an island report on the detached twin, reachable only via the investigationParent FK.
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
                    appSlug: "report-app",
                    testCount: 4,
                    clientBugCount: 0,
                },
            });

            // PR C: a legacy report with no island header - must be skipped (would open an empty page).
            const prC = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-c" },
            });
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: prC.id,
                    organizationId: harness.organizationId,
                    s3Key: "investigation/report-app/batch-c-legacy.md",
                    testCount: 1,
                    clientBugCount: 0,
                },
            });

            // PR D: no report at all.
            const prD = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: "batch-d" },
            });

            const presence = await harness.services.branches.getInvestigationReportsForSnapshots(
                [prA.id, prB.id, prC.id, prD.id],
                harness.organizationId,
            );

            const byId = new Map(presence.map((entry) => [entry.snapshotId, entry]));
            expect(byId.size).toBe(2);
            // warningCount counts only scenario/environment findings (2), never the passed one.
            expect(byId.get(prA.id)).toMatchObject({ clientBugCount: 2, warningCount: 2, status: "completed" });
            // The twin's report is keyed back to the PR snapshot the UI routes on, not the twin id.
            expect(byId.get(prB.id)).toMatchObject({ clientBugCount: 0, warningCount: 0, status: "completed" });
            expect(byId.has(twinB.id)).toBe(false);
            expect(byId.has(prC.id)).toBe(false);
            expect(byId.has(prD.id)).toBe(false);
        });
    },
});
