import type { InvestigationReportData } from "@autonoma/types";
import { expect } from "vitest";
import { InvestigationReportPersister } from "../../src";
import { investigationDbSuite } from "../harness";

/** A representative report: one client_bug finding (with media + evidence), one passed, and a suggested test. */
function sampleReportData(): InvestigationReportData {
    return {
        client: "Acme",
        appSlug: "acme-web",
        prNumber: 42,
        prTitle: "Add checkout",
        prBody: "Implements the checkout flow.",
        repoFullName: "acme/web",
        commitSha: "abc123",
        findings: [
            {
                id: "checkout-flow",
                slug: "checkout-flow",
                category: "client_bug",
                confidence: "high",
                planFidelity: "faithful",
                falsePositiveRisk: "low",
                headline: "Checkout total is wrong",
                whatHappened: "The total ignored tax.",
                observedAppIssues: "Tax line missing.",
                remediation: "Include tax in the total.",
                rootCause: "computeTotal drops the tax term.",
                suggestedFixDiff: "- old\n+ new",
                evidence: [{ source: "code", detail: "here", file: "src/total.ts", lines: "10-12", snippet: "sum()" }],
                plan: "1. add item 2. check total",
                runSuccess: false,
                stepCount: 5,
                runSteps: ["click add", "assert total FAILED"],
                videoUrl: "s3://bucket/video.webm",
                finalScreenshotUrl: "s3://bucket/shot.png",
            },
            {
                id: "login",
                slug: "login",
                category: "passed",
                headline: "Login works",
                evidence: [],
            },
        ],
        suggested: [
            {
                name: "Guest checkout",
                instruction: "Check out without an account",
                reasoning: "The PR adds a guest path.",
                validation: { passed: true, iterations: 2 },
            },
        ],
        quarantine: [],
        deployed: {
            found: true,
            jobStatus: "completed",
            perTest: [{ testSlug: "checkout-flow", runStatus: "failed" }],
        },
    };
}

investigationDbSuite({
    name: "InvestigationReportPersister",
    cases: (test) => {
        test("persists a report into the island tables with all findings and suggested tests", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            // Distinct slug per test: the suite shares one application, and setupTestCase renames the created
            // test case's slug, which is unique per (application, slug).
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "persist-report-flow");
            const data = sampleReportData();

            await new InvestigationReportPersister(harness.db).persist({
                snapshotId,
                organizationId,
                data,
                s3Key: `investigation/${application.slug}/${snapshotId}.md`,
            });

            const report = await harness.db.investigationReport.findUniqueOrThrow({
                where: { snapshotId },
                include: {
                    findings: { orderBy: { displayOrder: "asc" } },
                    suggestedTests: true,
                },
            });

            expect(report.status).toBe("completed");
            expect(report.client).toBe("Acme");
            expect(report.prNumber).toBe(42);
            expect(report.testCount).toBe(2);
            expect(report.clientBugCount).toBe(1);
            expect(report.deployed).toEqual(data.deployed);

            expect(report.findings).toHaveLength(2);
            const bug = report.findings[0];
            expect(bug?.findingKey).toBe("checkout-flow");
            expect(bug?.category).toBe("client_bug");
            expect(bug?.videoKey).toBe("s3://bucket/video.webm");
            expect(bug?.screenshotKey).toBe("s3://bucket/shot.png");
            expect(bug?.runSteps).toEqual(["click add", "assert total FAILED"]);
            expect(bug?.evidence).toEqual(data.findings[0]?.evidence);

            expect(report.suggestedTests).toHaveLength(1);
            expect(report.suggestedTests[0]?.name).toBe("Guest checkout");
            expect(report.suggestedTests[0]?.validationPassed).toBe(true);
            expect(report.suggestedTests[0]?.validationIterations).toBe(2);
        });

        test("re-persisting the same snapshot replaces children (idempotent), never duplicating", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const { snapshotId } = await harness.setupTestCase(organizationId, application.id, "rerun-report-flow");
            const persister = new InvestigationReportPersister(harness.db);

            await persister.persist({ snapshotId, organizationId, data: sampleReportData() });

            // A re-run classifies fewer tests and drops the suggested test.
            const rerun: InvestigationReportData = {
                ...sampleReportData(),
                findings: [
                    {
                        id: "checkout-flow",
                        slug: "checkout-flow",
                        category: "passed",
                        headline: "Now passes",
                        evidence: [],
                    },
                ],
                suggested: [],
                quarantine: [],
            };
            await persister.persist({ snapshotId, organizationId, data: rerun });

            const report = await harness.db.investigationReport.findUniqueOrThrow({
                where: { snapshotId },
                include: { findings: true, suggestedTests: true },
            });
            expect(report.findings).toHaveLength(1);
            expect(report.findings[0]?.category).toBe("passed");
            expect(report.clientBugCount).toBe(0);
            expect(report.suggestedTests).toHaveLength(0);

            // No orphans: the whole app's finding rows equal the single re-run finding.
            const allFindings = await harness.db.investigationFinding.count({
                where: { reportSnapshotId: snapshotId },
            });
            expect(allFindings).toBe(1);
        });
    },
});
