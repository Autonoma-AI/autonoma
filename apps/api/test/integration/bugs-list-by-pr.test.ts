import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

async function seedFixture(harness: APITestHarness) {
    const application = await harness.services.applications.createApplication({
        name: "Bug PR App",
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });

    const folder = await harness.db.folder.create({
        data: {
            name: "Checkout",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const testCase = await harness.db.testCase.create({
        data: {
            name: "Checkout succeeds",
            slug: "checkout-succeeds",
            applicationId: application.id,
            folderId: folder.id,
            organizationId: harness.organizationId,
        },
    });

    const testPlan = await harness.db.testPlan.create({
        data: {
            testCaseId: testCase.id,
            prompt: "Verify checkout succeeds.",
            organizationId: harness.organizationId,
        },
    });

    const runTestCase = await harness.db.testCase.create({
        data: {
            name: "Checkout run catches regression",
            slug: "checkout-run-catches-regression",
            applicationId: application.id,
            folderId: folder.id,
            organizationId: harness.organizationId,
        },
    });

    const runTestPlan = await harness.db.testPlan.create({
        data: {
            testCaseId: runTestCase.id,
            prompt: "Verify checkout run catches regression.",
            organizationId: harness.organizationId,
        },
    });

    const branch = await harness.db.branch.create({
        data: {
            name: "feature/pr-bugs",
            applicationId: application.id,
            organizationId: harness.organizationId,
            prInfo: { create: { applicationId: application.id, prNumber: 123 } },
        },
    });

    const otherBranch = await harness.db.branch.create({
        data: {
            name: "feature/other",
            applicationId: application.id,
            organizationId: harness.organizationId,
            prInfo: { create: { applicationId: application.id, prNumber: 124 } },
        },
    });

    const [firstSnapshot, secondSnapshot, otherSnapshot] = await Promise.all([
        harness.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "GITHUB_PUSH",
                status: "active",
            },
        }),
        harness.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "GITHUB_PUSH",
                status: "active",
            },
        }),
        harness.db.branchSnapshot.create({
            data: {
                branchId: otherBranch.id,
                source: "GITHUB_PUSH",
                status: "active",
            },
        }),
    ]);

    const prBug = await harness.db.bug.create({
        data: {
            title: "Checkout button crashes",
            description: "The checkout button throws during payment.",
            severity: "critical",
            applicationId: application.id,
            organizationId: harness.organizationId,
            evidence: {
                create: {
                    testCaseId: testCase.id,
                },
            },
        },
    });

    const otherBranchBug = await harness.db.bug.create({
        data: {
            title: "Other branch bug",
            description: "A bug on a different branch.",
            severity: "high",
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const resolvedBug = await harness.db.bug.create({
        data: {
            title: "Resolved PR bug",
            description: "A resolved bug on this PR.",
            severity: "medium",
            status: "resolved",
            resolvedAt: new Date(),
            applicationId: application.id,
            organizationId: harness.organizationId,
        },
    });

    const secondSnapshotBug = await harness.db.bug.create({
        data: {
            title: "Second snapshot only bug",
            description: "A bug that only appears on the second snapshot.",
            severity: "high",
            applicationId: application.id,
            organizationId: harness.organizationId,
            evidence: {
                create: {
                    testCaseId: testCase.id,
                },
            },
        },
    });

    const runReviewBug = await harness.db.bug.create({
        data: {
            title: "Run review bug",
            description: "A bug reported from replay review.",
            severity: "medium",
            applicationId: application.id,
            organizationId: harness.organizationId,
            evidence: {
                create: {
                    testCaseId: runTestCase.id,
                },
            },
        },
    });

    await createIssueForBug(harness, {
        bugId: prBug.id,
        snapshotId: firstSnapshot.id,
        testPlanId: testPlan.id,
        title: "Checkout fails on first snapshot",
        screenshotKey: "evidence/first-snapshot.jpeg",
    });
    await createIssueForBug(harness, {
        bugId: prBug.id,
        snapshotId: secondSnapshot.id,
        testPlanId: testPlan.id,
        title: "Checkout fails on second snapshot",
        screenshotKey: "evidence/second-snapshot.jpeg",
    });
    await createIssueForBug(harness, {
        bugId: otherBranchBug.id,
        snapshotId: otherSnapshot.id,
        testPlanId: testPlan.id,
        title: "Other branch issue",
    });
    await createIssueForBug(harness, {
        bugId: resolvedBug.id,
        snapshotId: secondSnapshot.id,
        testPlanId: testPlan.id,
        title: "Resolved issue",
    });
    await createIssueForBug(harness, {
        bugId: secondSnapshotBug.id,
        snapshotId: secondSnapshot.id,
        testPlanId: testPlan.id,
        title: "Second snapshot issue without thumbnail",
    });
    await createRunIssueForBug(harness, {
        bugId: runReviewBug.id,
        snapshotId: secondSnapshot.id,
        testCaseId: runTestCase.id,
        testPlanId: runTestPlan.id,
        title: "Run review issue with thumbnail",
        screenshotKey: "evidence/run-review.jpeg",
    });

    return {
        application,
        branch,
        firstSnapshot,
        secondSnapshot,
        prBug,
        otherBranchBug,
        resolvedBug,
        secondSnapshotBug,
        runReviewBug,
    };
}

async function createIssueForBug(
    harness: APITestHarness,
    input: {
        bugId: string;
        snapshotId: string;
        testPlanId: string;
        title: string;
        screenshotKey?: string;
    },
) {
    const generation = await harness.db.testGeneration.create({
        data: {
            testPlanId: input.testPlanId,
            snapshotId: input.snapshotId,
            organizationId: harness.organizationId,
        },
    });

    const review = await harness.db.generationReview.create({
        data: {
            generationId: generation.id,
            status: "completed",
            verdict: "application_bug",
            analysis: buildAnalysis(input.screenshotKey),
            organizationId: harness.organizationId,
        },
    });

    await harness.db.issue.create({
        data: {
            generationReviewId: review.id,
            bugId: input.bugId,
            title: input.title,
            description: input.title,
            severity: "critical",
            organizationId: harness.organizationId,
        },
    });
}

async function createRunIssueForBug(
    harness: APITestHarness,
    input: {
        bugId: string;
        snapshotId: string;
        testCaseId: string;
        testPlanId: string;
        title: string;
        screenshotKey?: string;
    },
) {
    const assignment = await harness.db.testCaseAssignment.create({
        data: {
            snapshotId: input.snapshotId,
            testCaseId: input.testCaseId,
            planId: input.testPlanId,
        },
    });

    const run = await harness.db.run.create({
        data: {
            assignmentId: assignment.id,
            status: "failed",
            organizationId: harness.organizationId,
        },
    });

    const review = await harness.db.runReview.create({
        data: {
            runId: run.id,
            status: "completed",
            verdict: "application_bug",
            analysis: buildAnalysis(input.screenshotKey),
            organizationId: harness.organizationId,
        },
    });

    await harness.db.issue.create({
        data: {
            runReviewId: review.id,
            bugId: input.bugId,
            title: input.title,
            description: input.title,
            severity: "critical",
            organizationId: harness.organizationId,
        },
    });
}

function buildAnalysis(screenshotKey: string | undefined) {
    if (screenshotKey == null) return {};
    return {
        evidence: [
            {
                type: "screenshot",
                description: "Failure screenshot",
                s3Key: screenshotKey,
            },
        ],
    };
}

apiTestSuite({
    name: "bugs.listByPr",
    seed: async ({ harness }) => seedFixture(harness),
    cases: (test) => {
        test("returns open bugs scoped to a PR branch", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.listByPr({
                applicationId: seedResult.application.id,
                branchId: seedResult.branch.id,
            });

            expect(bugs.map((bug) => bug.id)).toEqual(
                expect.arrayContaining([seedResult.prBug.id, seedResult.secondSnapshotBug.id]),
            );
            expect(bugs.find((bug) => bug.id === seedResult.prBug.id)?.occurrences).toBe(2);
            expect(bugs.map((bug) => bug.id)).not.toContain(seedResult.otherBranchBug.id);
            expect(bugs.map((bug) => bug.id)).not.toContain(seedResult.resolvedBug.id);
            expect(bugs.map((bug) => bug.id)).not.toContain(seedResult.runReviewBug.id);
        });

        test("returns bugs scoped to a snapshot with thumbnails", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.listByPr({
                applicationId: seedResult.application.id,
                branchId: seedResult.branch.id,
                snapshotId: seedResult.secondSnapshot.id,
            });

            expect(bugs.map((bug) => bug.id)).toEqual(
                expect.arrayContaining([
                    seedResult.prBug.id,
                    seedResult.secondSnapshotBug.id,
                    seedResult.runReviewBug.id,
                ]),
            );
            expect(bugs.map((bug) => bug.id)).not.toContain(seedResult.otherBranchBug.id);
            expect(bugs.map((bug) => bug.id)).not.toContain(seedResult.resolvedBug.id);

            const repeatedBug = bugs.find((bug) => bug.id === seedResult.prBug.id);
            expect(repeatedBug?.occurrences).toBe(1);
            expect(repeatedBug?.thumbnail?.url).toContain("evidence/second-snapshot.jpeg");

            const runReviewBug = bugs.find((bug) => bug.id === seedResult.runReviewBug.id);
            expect(runReviewBug?.occurrences).toBe(1);
            expect(runReviewBug?.thumbnail?.url).toContain("evidence/run-review.jpeg");

            const bugWithoutThumbnail = bugs.find((bug) => bug.id === seedResult.secondSnapshotBug.id);
            expect(bugWithoutThumbnail?.thumbnail).toBeUndefined();
        });

        test("does not include bugs from other snapshots when snapshot scoped", async ({ harness, seedResult }) => {
            const bugs = await harness.request().bugs.listByPr({
                applicationId: seedResult.application.id,
                branchId: seedResult.branch.id,
                snapshotId: seedResult.firstSnapshot.id,
            });

            expect(bugs.map((bug) => bug.id)).toEqual([seedResult.prBug.id]);
            expect(bugs[0]?.occurrences).toBe(1);
            expect(bugs[0]?.thumbnail?.url).toContain("evidence/first-snapshot.jpeg");
        });
    },
});
