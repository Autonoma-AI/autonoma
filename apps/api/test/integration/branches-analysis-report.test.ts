import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "branches.analysisReport",
    cases: (test) => {
        test("returns the report header, narration, and findings ordered by display order", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);

            await harness.db.analysisReport.create({
                data: {
                    snapshotId,
                    verdict: "client_bug",
                    testCount: 2,
                    clientBugCount: 1,
                    impactReasoning: "Selected the checkout tests because the PR touches the cart.",
                    narration: "The checkout flow has a client bug: the submit button never enables.",
                    organizationId: harness.organizationId,
                    findings: {
                        create: [
                            {
                                findingKey: "checkout-submit",
                                slug: "checkout-submit",
                                category: "client_bug",
                                headline: "Submit never enables",
                                whatHappened: "The submit button stays disabled after filling the form.",
                                confidence: "high",
                                displayOrder: 0,
                                organizationId: harness.organizationId,
                            },
                            {
                                findingKey: "cart-empties",
                                slug: "cart-empties",
                                category: "passed",
                                headline: "Cart empties correctly",
                                displayOrder: 1,
                                organizationId: harness.organizationId,
                            },
                        ],
                    },
                },
            });

            const report = await harness.request().branches.analysisReport({ snapshotId });

            expect(report).not.toBeNull();
            expect(report?.impactReasoning).toContain("checkout");
            expect(report?.narration).toContain("client bug");
            expect(report?.findings.map((f) => f.id)).toEqual(["checkout-submit", "cart-empties"]);

            const bug = report?.findings.find((f) => f.category === "client_bug");
            expect(bug).toMatchObject({
                slug: "checkout-submit",
                headline: "Submit never enables",
                whatHappened: "The submit button stays disabled after filling the form.",
                confidence: "high",
            });
        });

        test("returns null for a snapshot without an analysis report", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);

            const report = await harness.request().branches.analysisReport({ snapshotId });

            expect(report).toBeNull();
        });

        test("snapshotDetail loads for an authoritative snapshot that has no diffs job", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);

            const detail = await harness.request().branches.snapshotDetail({ snapshotId });

            // No DiffsJob exists (authoritative snapshots track status via an AnalysisJob), so the detail
            // synthesizes an empty, terminal diffs job instead of 404ing - the changes tab still loads.
            expect(detail.diffsJob.status).toBe("completed");
            expect(detail.diffsJob.affectedTests).toEqual([]);
        });
    },
});

/** An active snapshot with an AnalysisJob and NO DiffsJob - the authoritative-mode shape. */
async function createAuthoritativeSnapshot(harness: APITestHarness): Promise<{ snapshotId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `Analysis Report ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
    const branch = await harness.db.branch.findFirstOrThrow({
        where: { applicationId: application.id },
        select: { activeSnapshotId: true },
    });
    if (branch.activeSnapshotId == null) throw new Error("Expected createApplication to create an active snapshot");

    await harness.db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { status: "active", baseSha: "base-sha", headSha: "head-sha" },
    });
    await harness.db.analysisJob.create({
        data: {
            snapshotId: branch.activeSnapshotId,
            status: "completed",
            organizationId: harness.organizationId,
        },
    });

    return { snapshotId: branch.activeSnapshotId };
}
