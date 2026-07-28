import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "FalsePositiveCandidateService (MCP channel)",
    seed: async ({ harness }) => {
        const application = await harness.services.applications.createApplication({
            name: "FP App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });
        return { application };
    },
    cases: (test) => {
        test("report_false_positive on a known finding writes one mcp_client_agent candidate and touches nothing else", async ({
            harness,
            seedResult: { application },
        }) => {
            const prNumber = 7001;
            const repoFullName = "org/fp-mcp-known";
            const { snapshotId } = await seedInvestigationFinding(harness, application.id, prNumber, {
                findingKey: "f1",
                slug: "checkout",
            });

            const result = await harness.services.falsePositiveCandidates.reportFromMcp({
                organizationId: harness.organizationId,
                applicationId: application.id,
                repoFullName,
                prNumber,
                findingId: "f1",
                reportedBy: "user-abc",
                reason: "checkout actually works, the test used stale data",
            });

            expect(result).toEqual({ status: "recorded", snapshotId, findingKey: "f1" });

            const candidates = await harness.db.findingFalsePositiveCandidate.findMany({
                where: { repoFullName, prNumber },
            });
            expect(candidates).toHaveLength(1);
            expect(candidates[0]).toMatchObject({
                organizationId: harness.organizationId,
                snapshotId,
                findingKey: "f1",
                source: "mcp_client_agent",
                reportedBy: "user-abc",
                reason: "checkout actually works, the test used stale data",
            });

            // Tracking only: the finding is untouched and no merge-gate check row was created.
            const finding = await harness.db.investigationFinding.findFirst({
                where: { reportSnapshotId: snapshotId, findingKey: "f1" },
            });
            expect(finding?.headline).toBe("Checkout is broken");
            expect(await harness.db.gitHubCheckRun.findFirst({ where: { repoFullName } })).toBeNull();
        });

        test("report_false_positive with an unknown finding id writes nothing and returns the known ids", async ({
            harness,
            seedResult: { application },
        }) => {
            const prNumber = 7002;
            const repoFullName = "org/fp-mcp-unknown";
            await seedInvestigationFinding(harness, application.id, prNumber, { findingKey: "real-1", slug: "login" });

            const result = await harness.services.falsePositiveCandidates.reportFromMcp({
                organizationId: harness.organizationId,
                applicationId: application.id,
                repoFullName,
                prNumber,
                findingId: "does-not-exist",
                reportedBy: "user-abc",
            });

            expect(result).toEqual({ status: "finding_not_found", knownFindingIds: ["real-1"] });
            expect(await harness.db.findingFalsePositiveCandidate.findMany({ where: { repoFullName } })).toHaveLength(
                0,
            );
        });

        test("report_false_positive on a PR with no renderable report returns no_report and writes nothing", async ({
            harness,
            seedResult: { application },
        }) => {
            const prNumber = 7003;
            const repoFullName = "org/fp-mcp-noreport";
            // A branch + PR + snapshot, but no InvestigationReport: nothing to report against.
            const branch = await harness.db.branch.create({
                data: {
                    name: `feature/pr-${prNumber}`,
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                },
            });
            await harness.db.featureBranchInfo.create({
                data: { branchId: branch.id, applicationId: application.id, prNumber },
            });
            await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "GITHUB_PUSH", headSha: `pr-${prNumber}-sha` },
            });

            const result = await harness.services.falsePositiveCandidates.reportFromMcp({
                organizationId: harness.organizationId,
                applicationId: application.id,
                repoFullName,
                prNumber,
                findingId: "whatever",
                reportedBy: "user-abc",
            });

            expect(result).toEqual({ status: "no_report" });
            expect(await harness.db.findingFalsePositiveCandidate.findMany({ where: { repoFullName } })).toHaveLength(
                0,
            );
        });

        test("report_false_positive naming a finding from an earlier push returns the latest ids and writes nothing", async ({
            harness,
            seedResult: { application },
        }) => {
            const prNumber = 7004;
            const repoFullName = "org/fp-mcp-stale";
            const branch = await harness.db.branch.create({
                data: {
                    name: `feature/pr-${prNumber}-${crypto.randomUUID()}`,
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                },
            });
            await harness.db.featureBranchInfo.create({
                data: { branchId: branch.id, applicationId: application.id, prNumber },
            });
            // An earlier push whose report flagged "old-finding", superseded by a newer push flagging a different
            // finding: resolution keys to the LATEST snapshot, so the stale id is not in its report.
            await seedSnapshotReport(harness, branch.id, {
                findingKey: "old-finding",
                createdAt: new Date("2026-07-01T00:00:00Z"),
            });
            await seedSnapshotReport(harness, branch.id, {
                findingKey: "new-finding",
                createdAt: new Date("2026-07-02T00:00:00Z"),
            });

            const result = await harness.services.falsePositiveCandidates.reportFromMcp({
                organizationId: harness.organizationId,
                applicationId: application.id,
                repoFullName,
                prNumber,
                findingId: "old-finding",
                reportedBy: "user-abc",
            });

            expect(result).toEqual({ status: "finding_not_found", knownFindingIds: ["new-finding"] });
            expect(await harness.db.findingFalsePositiveCandidate.findMany({ where: { repoFullName } })).toHaveLength(
                0,
            );
        });

        test("a duplicate report_false_positive appends a second signal row - candidates are not deduplicated", async ({
            harness,
            seedResult: { application },
        }) => {
            const prNumber = 7005;
            const repoFullName = "org/fp-mcp-dup";
            await seedInvestigationFinding(harness, application.id, prNumber, { findingKey: "f1", slug: "checkout" });

            const report = {
                organizationId: harness.organizationId,
                applicationId: application.id,
                repoFullName,
                prNumber,
                findingId: "f1",
                reportedBy: "user-abc",
            };
            const first = await harness.services.falsePositiveCandidates.reportFromMcp(report);
            const second = await harness.services.falsePositiveCandidates.reportFromMcp(report);

            expect(first.status).toBe("recorded");
            expect(second.status).toBe("recorded");
            expect(
                await harness.db.findingFalsePositiveCandidate.findMany({ where: { repoFullName, findingKey: "f1" } }),
            ).toHaveLength(2);
        });
    },
});

/**
 * Seed the resolution path `report_false_positive` shares with `get_investigation`: a branch tied to the PR, a
 * checkpoint snapshot, an island InvestigationReport (appSlug set so it renders), and one finding. Returns the
 * snapshot id the report is keyed to. The finding's report `id` equals its `findingKey`.
 */
async function seedInvestigationFinding(
    harness: APITestHarness,
    applicationId: string,
    prNumber: number,
    finding: { findingKey: string; slug: string },
): Promise<{ snapshotId: string }> {
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/pr-${prNumber}-${crypto.randomUUID()}`,
            applicationId,
            organizationId: harness.organizationId,
        },
    });
    await harness.db.featureBranchInfo.create({
        data: { branchId: branch.id, applicationId, prNumber },
    });
    const snapshotId = await seedSnapshotReport(harness, branch.id, finding);
    return { snapshotId };
}

/**
 * Seed one checkpoint snapshot on an existing branch with a renderable InvestigationReport and a single finding.
 * Pass `createdAt` to control which snapshot is "latest" when a branch has several - resolution keys to the newest.
 */
async function seedSnapshotReport(
    harness: APITestHarness,
    branchId: string,
    finding: { findingKey: string; slug?: string; createdAt?: Date },
): Promise<string> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: {
            branchId,
            source: "GITHUB_PUSH",
            headSha: `${finding.findingKey}-${crypto.randomUUID()}`,
            createdAt: finding.createdAt,
        },
    });
    await harness.db.investigationReport.create({
        data: {
            snapshotId: snapshot.id,
            organizationId: harness.organizationId,
            appSlug: "fp-app",
            testCount: 1,
            clientBugCount: 1,
        },
    });
    await harness.db.investigationFinding.create({
        data: {
            reportSnapshotId: snapshot.id,
            organizationId: harness.organizationId,
            findingKey: finding.findingKey,
            slug: finding.slug ?? finding.findingKey,
            category: "client_bug",
            headline: "Checkout is broken",
            displayOrder: 0,
        },
    });
    return snapshot.id;
}
