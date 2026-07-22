import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/**
 * The checkpoint-history rail (branches.snapshotHistory) must read an authoritative snapshot's badge from the
 * AnalysisReport verdict + finding categories, not the legacy health/Bug model the merged pipeline never
 * populates. A legacy diffs snapshot must be untouched.
 */

async function createBranch(harness: APITestHarness): Promise<{ branchId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by createApplication
    return { branchId: application.mainBranchId! };
}

async function createSnapshot(harness: APITestHarness, branchId: string, headSha: string): Promise<string> {
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "GITHUB_PUSH", status: "active", baseSha: "base", headSha },
    });
    return snapshot.id;
}

async function attachAnalysisReport(
    harness: APITestHarness,
    snapshotId: string,
    verdict: string,
    categories: string[],
): Promise<void> {
    await harness.db.analysisJob.create({
        data: { snapshotId, status: "completed", organizationId: harness.organizationId },
    });
    await harness.db.analysisReport.create({
        data: {
            snapshotId,
            verdict,
            organizationId: harness.organizationId,
            findings: {
                create: categories.map((category, index) => ({
                    findingKey: `finding-${index}`,
                    slug: `slug-${index}`,
                    category,
                    headline: `Finding ${index}`,
                    displayOrder: index,
                    organizationId: harness.organizationId,
                })),
            },
        },
    });
}

apiTestSuite({
    name: "branches authoritative summary",
    cases: (test) => {
        test("a client-bug authoritative checkpoint reads 'N bugs' (red), never awaiting-triage", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-bug");
            // One client bug, two passed, one coverage-plane finding.
            await attachAnalysisReport(harness, snapshotId, "client_bug", [
                "client_bug",
                "passed",
                "passed",
                "engine_artifact",
            ]);

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("critical");
            expect(row?.summary?.label).toBe("1 bug");
            expect(row?.summary?.reason).toBeUndefined();
            expect(row?.summary?.analysis).toEqual({
                jobStatus: "completed",
                bugCount: 1,
                passedCount: 2,
                coverageCount: 1,
            });
            expect(row?.bugCount).toBe(1);
            expect(row?.health).toBe("critical");
        });

        test("a passing authoritative checkpoint reads 'Passing' (green), coverage findings do not block", async ({
            harness,
        }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-pass");
            // No client bugs; a coverage finding must not turn it red or awaiting-triage.
            await attachAnalysisReport(harness, snapshotId, "passed", ["passed", "passed", "scenario_issue"]);

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.tone).toBe("success");
            expect(row?.summary?.label).toBe("Passing");
            expect(row?.summary?.reason).toBe("1 couldn't confirm");
            expect(row?.summary?.analysis?.bugCount).toBe(0);
            expect(row?.bugCount).toBe(0);
            expect(row?.health).toBe("healthy");
        });

        test("a legacy diffs snapshot carries no authoritative analysis on its summary", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const snapshotId = await createSnapshot(harness, branchId, "head-legacy");
            await harness.db.diffsJob.create({
                data: { snapshotId, status: "completed", organizationId: harness.organizationId },
            });

            const history = await harness.request().branches.snapshotHistory({ branchId });
            const row = history.find((s) => s.id === snapshotId);

            expect(row?.summary?.analysis).toBeUndefined();
        });
    },
});
