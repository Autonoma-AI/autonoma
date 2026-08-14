import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings, seedAnalysisIssue } from "../seed-analysis-findings";

/**
 * Deleting a test drops its assignment from the branch's active snapshot and nothing else. The `TestCase` row is
 * an identity record: it cascades to `AnalysisFinding` and terminal snapshots' assignments, so destroying it would
 * rewrite a frozen run's suite and erase the covered set an open issue needs to ever be resolved.
 */

interface SeededBranch {
    branchId: string;
    terminalSnapshotId: string;
    activeSnapshotId: string;
    testCaseId: string;
    issueId: string;
    slug: string;
}

/** A branch whose live suite assigns one test, and whose history has that test covering an open bug issue. */
async function seedBranchWithHistory(harness: APITestHarness, slug: string): Promise<SeededBranch> {
    const application = await harness.services.applications.createApplication({
        name: `Delete ${randomBytes(4).toString("hex")}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    const branchId = application.mainBranchId;
    if (branchId == null) throw new Error("expected the application to have a main branch");

    const terminal = await harness.db.branchSnapshot.create({
        data: { branchId, source: "GITHUB_PUSH", status: "superseded", headSha: "head-1" },
        select: { id: true },
    });
    await harness.db.analysisJob.create({
        data: { snapshotId: terminal.id, status: "completed", organizationId: harness.organizationId },
    });
    const findingIdOf = await seedAnalysisFindings(harness.db, terminal.id, [{ slug, category: "client_bug" }]);

    const testCase = await harness.db.testCase.findUniqueOrThrow({
        where: { applicationId_slug: { applicationId: application.id, slug } },
        select: { id: true },
    });
    await harness.db.testCaseAssignment.create({ data: { snapshotId: terminal.id, testCaseId: testCase.id } });

    const issueId = await seedAnalysisIssue(harness.db, {
        branchId,
        organizationId: harness.organizationId,
        title: `${slug} is broken`,
        kind: "bug",
        actualBehavior: `${slug} failed.`,
        narrativeMarkdown: `## ${slug}`,
    });
    await harness.db.analysisFinding.update({ where: { id: findingIdOf(slug) }, data: { issueId } });

    const active = await harness.db.branchSnapshot.create({
        data: {
            branchId,
            source: "GITHUB_PUSH",
            status: "active",
            headSha: "head-2",
            prevSnapshotId: terminal.id,
        },
        select: { id: true },
    });
    await harness.db.testCaseAssignment.create({ data: { snapshotId: active.id, testCaseId: testCase.id } });
    await harness.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: active.id } });

    return {
        branchId,
        terminalSnapshotId: terminal.id,
        activeSnapshotId: active.id,
        testCaseId: testCase.id,
        issueId,
        slug,
    };
}

apiTestSuite({
    name: "tests.delete",
    seed: async ({ harness }) => {
        harness.user = await harness.db.user.update({ where: { id: harness.userId }, data: { role: "admin" } });
    },
    cases: (test) => {
        test("drops the test from the branch's live suite and destroys nothing else", async ({ harness }) => {
            const seeded = await seedBranchWithHistory(harness, "checkout-flow");

            await harness.request().tests.delete({ testId: seeded.testCaseId, branchId: seeded.branchId });

            const assignments = await harness.db.testCaseAssignment.findMany({
                where: { testCaseId: seeded.testCaseId },
                select: { snapshotId: true },
            });
            expect(assignments.map((assignment) => assignment.snapshotId)).toEqual([seeded.terminalSnapshotId]);

            const testCase = await harness.db.testCase.findUnique({ where: { id: seeded.testCaseId } });
            expect(testCase).not.toBeNull();

            const findings = await harness.db.analysisFinding.count({ where: { testCaseId: seeded.testCaseId } });
            expect(findings).toBe(1);
        });

        test("keeps the covered set an open issue needs to be resolved", async ({ harness }) => {
            const seeded = await seedBranchWithHistory(harness, "login-flow");

            await harness.request().tests.delete({ testId: seeded.testCaseId, branchId: seeded.branchId });

            // The issue's covered set is derived from its findings, and a resolve is only accepted for a test the
            // issue actually covers - so an issue that lost its findings could never be closed again.
            const issue = await harness.request().branches.analysisIssueDetail({ issueId: seeded.issueId });
            expect(issue?.findingInstances.map((instance) => instance.slug)).toEqual([seeded.slug]);
        });

        test("a test the branch's active snapshot does not assign is not found", async ({ harness }) => {
            const seeded = await seedBranchWithHistory(harness, "settings-flow");
            const input = { testId: seeded.testCaseId, branchId: seeded.branchId };

            await harness.request().tests.delete(input);

            await expect(harness.request().tests.delete(input)).rejects.toThrow(/not found/i);
        });
    },
});
