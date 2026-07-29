import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

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
                    summary: "The checkout flow has a client bug: the submit button never enables.",
                    reportMarkdown: "## Checkout is broken\nThe submit button never enables.",
                    organizationId: harness.organizationId,
                },
            });
            // Findings key to the AnalysisJob (created by createAuthoritativeSnapshot); each verdict FKs the
            // generation whose run produced it.
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "checkout-submit",
                    category: "client_bug",
                    headline: "Submit never enables",
                    classification: {
                        whatHappened: "The submit button stays disabled after filling the form.",
                        confidence: "high",
                    },
                },
                { slug: "cart-empties", category: "passed", headline: "Cart empties correctly" },
            ]);

            const report = await harness.request().branches.analysisReport({ snapshotId });

            expect(report).not.toBeNull();
            expect(report?.impactReasoning).toContain("checkout");
            expect(report?.summary).toContain("client bug");
            // Bugs sort ahead of passing checks, and each finding is routed by its own id.
            expect(report?.findings.map((f) => f.id)).toEqual([
                findingFor("checkout-submit"),
                findingFor("cart-empties"),
            ]);

            const bug = report?.findings.find((f) => f.category === "client_bug");
            expect(bug).toMatchObject({
                slug: "checkout-submit",
                headline: "Submit never enables",
                whatHappened: "The submit button stays disabled after filling the form.",
                confidence: "high",
            });
        });

        // The self-heal regression: a test classified twice surfaces ONCE, as the verdict the run stands behind,
        // with the superseded one reachable as history rather than counted as a second finding.
        test("surfaces a self-healed test once, with its superseded verdict kept as history", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            await harness.db.analysisReport.create({
                data: {
                    snapshotId,
                    verdict: "passed",
                    testCount: 1,
                    summary: "The rewritten test passes.",
                    reportMarkdown: "## Run\n\nThe rewritten test passes.",
                    organizationId: harness.organizationId,
                },
            });
            await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "cart-badge",
                    category: "passed",
                    headline: "Correct after the rewrite",
                    superseded: [{ category: "plan_mismatch", headline: "Asserts the old copy" }],
                },
            ]);

            const report = await harness.request().branches.analysisReport({ snapshotId });

            expect(report?.findings).toHaveLength(1);
            const finding = report?.findings[0];
            expect(finding?.category).toBe("passed");
            expect(finding?.headline).toBe("Correct after the rewrite");
            // Both iterations are readable, oldest first, each pointing at the run it judged.
            expect(finding?.classifications.map((c) => [c.number, c.category])).toEqual([
                [1, "plan_mismatch"],
                [2, "passed"],
            ]);
            const [superseded, current] = finding?.classifications ?? [];
            expect(superseded?.generationId).not.toBe(current?.generationId);
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
