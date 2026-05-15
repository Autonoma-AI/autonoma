import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "runs",
    seed: async ({ harness }) => {
        const application = await harness.services.applications.createApplication({
            name: "My Web App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });

        const mainBranch = await harness.db.branch.findFirstOrThrow({
            where: { applicationId: application.id },
            select: { activeSnapshotId: true },
        });

        // biome-ignore lint/style/noNonNullAssertion: `applications.createApplication` adds an active snapshot
        const snapshotId = mainBranch.activeSnapshotId!;

        const folder = await harness.db.folder.create({
            data: {
                name: "Default",
                applicationId: application.id,
                organizationId: harness.organizationId,
            },
        });

        const testCase = await harness.db.testCase.create({
            data: {
                name: "Login flow test",
                slug: "login-flow-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
                folderId: folder.id,
            },
        });

        const testPlan = await harness.db.testPlan.create({
            data: {
                prompt: "Navigate to login, enter credentials, assert dashboard is visible",
                testCaseId: testCase.id,
                organizationId: harness.organizationId,
            },
        });

        const stepInputList = await harness.db.stepInputList.create({
            data: { planId: testPlan.id, organizationId: harness.organizationId },
        });

        const si0 = await harness.db.stepInput.create({
            data: {
                listId: stepInputList.id,
                order: 0,
                interaction: "navigate",
                params: { url: "https://example.com/login" },
                organizationId: harness.organizationId,
            },
        });

        const si1 = await harness.db.stepInput.create({
            data: {
                listId: stepInputList.id,
                order: 1,
                interaction: "click",
                params: { description: "Sign in button" },
                organizationId: harness.organizationId,
            },
        });

        const stepOutputList = await harness.db.stepOutputList.create({
            data: { organizationId: harness.organizationId },
        });

        await harness.db.stepOutput.create({
            data: {
                listId: stepOutputList.id,
                order: 0,
                output: { outcome: "navigated successfully" },
                stepInputId: si0.id,
                organizationId: harness.organizationId,
            },
        });

        await harness.db.stepOutput.create({
            data: {
                listId: stepOutputList.id,
                order: 1,
                output: { outcome: "clicked sign in button" },
                stepInputId: si1.id,
                organizationId: harness.organizationId,
            },
        });

        // Generation with steps - simulates a completed test generation
        await harness.db.testGeneration.create({
            data: {
                testPlanId: testPlan.id,
                snapshotId,
                organizationId: harness.organizationId,
                status: "success",
                stepsId: stepInputList.id,
                outputsId: stepOutputList.id,
            },
        });

        // Assignment with stepsId already set - ready for replay
        const assignment = await harness.db.testCaseAssignment.create({
            data: {
                testCaseId: testCase.id,
                snapshotId,
                planId: testPlan.id,
                stepsId: stepInputList.id,
            },
        });

        // A test case with no steps - to test error path
        const testCaseNoSteps = await harness.db.testCase.create({
            data: {
                name: "Ungenerated test",
                slug: "ungenerated-test",
                applicationId: application.id,
                organizationId: harness.organizationId,
                folderId: folder.id,
            },
        });

        const testPlanNoSteps = await harness.db.testPlan.create({
            data: {
                prompt: "A test with no generation yet",
                testCaseId: testCaseNoSteps.id,
                organizationId: harness.organizationId,
            },
        });

        await harness.db.testCaseAssignment.create({
            data: {
                testCaseId: testCaseNoSteps.id,
                snapshotId,
                planId: testPlanNoSteps.id,
            },
        });

        return { application, testCase, assignment, stepOutputList, si0, si1, testCaseNoSteps, snapshotId };
    },
    cases: (test) => {
        test("trigger creates a run and calls workflow", async ({ harness, seedResult: { testCase, snapshotId } }) => {
            harness.triggerWorkflow.mockClear();

            const result = await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            expect(result.runId).toBeDefined();
            expect(harness.triggerWorkflow).toHaveBeenCalledOnce();
            expect(harness.triggerWorkflow).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId }));

            const run = await harness.db.run.findUnique({ where: { id: result.runId } });
            expect(run?.status).toBe("pending");
        });

        test("trigger throws NOT_FOUND when test case does not exist", async ({
            harness,
            seedResult: { snapshotId },
        }) => {
            await expect(
                harness.request().runs.trigger({
                    testCaseId: "non-existent-id",
                    snapshotId,
                }),
            ).rejects.toThrowError();
        });

        test("trigger throws NOT_FOUND when test case has no steps", async ({
            harness,
            seedResult: { testCaseNoSteps, snapshotId },
        }) => {
            await expect(
                harness.request().runs.trigger({
                    testCaseId: testCaseNoSteps.id,
                    snapshotId,
                }),
            ).rejects.toThrowError();
        });

        test("trigger marks run as failed when workflow throws", async ({
            harness,
            seedResult: { testCase, snapshotId },
        }) => {
            harness.triggerWorkflow.mockRejectedValueOnce(new Error("Temporal unavailable"));

            await expect(
                harness.request().runs.trigger({
                    testCaseId: testCase.id,
                    snapshotId,
                }),
            ).rejects.toThrowError("Temporal unavailable");

            const runs = await harness.db.run.findMany({
                where: { assignment: { testCaseId: testCase.id } },
                orderBy: { createdAt: "desc" },
            });
            expect(runs[0]?.status).toBe("failed");
        });

        test("list returns all runs for the organization", async ({
            harness,
            seedResult: { testCase, snapshotId },
        }) => {
            await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });
            await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            const runs = await harness.request().runs.list();
            expect(runs.length).toBeGreaterThanOrEqual(2);
        });

        test("list filters by applicationId", async ({
            harness,
            seedResult: { application, testCase, snapshotId },
        }) => {
            await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            const all = await harness.request().runs.list();
            const filtered = await harness.request().runs.list({ applicationId: application.id });
            const otherApp = await harness.request().runs.list({ applicationId: "other-app-id" });

            expect(filtered.length).toBeLessThanOrEqual(all.length);
            expect(filtered.every((r) => r.name === "Login flow test")).toBe(true);
            expect(otherApp).toHaveLength(0);
        });

        test("list returns correct shape", async ({ harness, seedResult: { testCase, snapshotId } }) => {
            const { runId } = await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            const runs = await harness.request().runs.list();
            const run = runs.find((r) => r.id === runId);

            expect(run).toBeDefined();
            expect(run?.shortId).toBe(runId.slice(0, 8));
            expect(run?.status).toBe("pending");
            expect(run?.name).toBe("Login flow test");
            expect(run?.tags).toEqual([]);
            expect(run?.stepCount).toBe(0);
            expect(run?.duration).toBeNull();
        });

        test("detail returns run with steps after completion", async ({
            harness,
            seedResult: { testCase, stepOutputList, snapshotId },
        }) => {
            const { runId } = await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            // Simulate the run completing with output steps
            await harness.db.stepOutputList.update({
                where: { id: stepOutputList.id },
                data: { runId },
            });
            await harness.db.run.update({
                where: { id: runId },
                data: { status: "success", startedAt: new Date(), completedAt: new Date() },
            });

            const detail = await harness.request().runs.detail({ runId });

            expect(detail).not.toBeNull();
            expect(detail?.id).toBe(runId);
            expect(detail?.shortId).toBe(runId.slice(0, 8));
            expect(detail?.status).toBe("success");
            expect(detail?.name).toBe("Login flow test");
            expect(detail?.steps).toHaveLength(2);
            expect(detail?.steps[0]?.interaction).toBe("navigate");
            expect(detail?.steps[0]?.order).toBe(0);
            expect(detail?.steps[1]?.interaction).toBe("click");
            expect(detail?.steps[1]?.order).toBe(1);
        });

        test("detail returns null for non-existent run", async ({ harness }) => {
            const detail = await harness.request().runs.detail({ runId: "non-existent-id" });
            expect(detail).toBeNull();
        });

        test("detail returns null for run belonging to another organization", async ({
            harness,
            seedResult: { testCase, snapshotId },
        }) => {
            const { runId } = await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: `other-org-${crypto.randomUUID()}` },
            });
            const otherSession = await harness.db.session.create({
                data: {
                    token: `other-session-${crypto.randomUUID()}`,
                    expiresAt: new Date(Date.now() + 86400000),
                    userId: harness.userId,
                    activeOrganizationId: otherOrg.id,
                },
            });

            const detail = await harness.request(otherSession).runs.detail({ runId });
            expect(detail).toBeNull();
        });

        test("restart creates a new run, triggers workflow with new id, and leaves original run untouched", async ({
            harness,
            seedResult: { testCase, stepOutputList, snapshotId },
        }) => {
            const { runId: originalRunId } = await harness.request().runs.trigger({
                testCaseId: testCase.id,
                snapshotId,
            });

            await harness.db.stepOutputList.update({
                where: { id: stepOutputList.id },
                data: { runId: originalRunId },
            });
            const completedAt = new Date();
            await harness.db.run.update({
                where: { id: originalRunId },
                data: {
                    status: "success",
                    startedAt: new Date(Date.now() - 60000),
                    completedAt,
                    reasoning: "original reasoning",
                },
            });

            harness.triggerWorkflow.mockClear();

            const result = await harness.request().runs.restart({ runId: originalRunId });

            expect(result.runId).toBeDefined();
            expect(result.runId).not.toBe(originalRunId);
            expect(harness.triggerWorkflow).toHaveBeenCalledOnce();
            expect(harness.triggerWorkflow).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId }));

            const newRun = await harness.db.run.findUnique({ where: { id: result.runId } });
            expect(newRun?.status).toBe("pending");
            expect(newRun?.assignmentId).toBeDefined();

            const originalRun = await harness.db.run.findUnique({
                where: { id: originalRunId },
                include: { outputs: true },
            });
            expect(originalRun?.status).toBe("success");
            expect(originalRun?.reasoning).toBe("original reasoning");
            expect(originalRun?.outputs?.id).toBe(stepOutputList.id);

            const preservedOutputs = await harness.db.stepOutputList.findUnique({
                where: { id: stepOutputList.id },
            });
            expect(preservedOutputs).not.toBeNull();
        });

        test("trigger throws PRECONDITION_FAILED when test is quarantined for the snapshot", async ({
            harness,
            seedResult: { application, testCase, snapshotId },
        }) => {
            const bug = await harness.db.bug.create({
                data: {
                    title: "Login broken",
                    description: "...",
                    severity: "high",
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                },
                select: { id: true },
            });
            const issue = await harness.db.issue.create({
                data: {
                    kind: "application_bug",
                    severity: "high",
                    title: "Login broken",
                    description: "...",
                    bugId: bug.id,
                    organizationId: harness.organizationId,
                },
                select: { id: true },
            });

            await harness.db.testCaseAssignment.update({
                where: { snapshotId_testCaseId: { snapshotId, testCaseId: testCase.id } },
                data: { quarantineIssueId: issue.id, stepsId: null },
            });

            const runsBefore = await harness.db.run.count({
                where: { assignment: { testCaseId: testCase.id, snapshotId } },
            });

            await expect(
                harness.request().runs.trigger({
                    testCaseId: testCase.id,
                    snapshotId,
                }),
            ).rejects.toThrowError(/quarantined/i);

            const runsAfter = await harness.db.run.count({
                where: { assignment: { testCaseId: testCase.id, snapshotId } },
            });
            expect(runsAfter).toBe(runsBefore);
        });

        test("trigger throws when test case belongs to another organization", async ({
            harness,
            seedResult: { testCase, snapshotId },
        }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org 2", slug: `other-org-2-${crypto.randomUUID()}` },
            });
            const otherSession = await harness.db.session.create({
                data: {
                    token: `other-session-2-${crypto.randomUUID()}`,
                    expiresAt: new Date(Date.now() + 86400000),
                    userId: harness.userId,
                    activeOrganizationId: otherOrg.id,
                },
            });

            await expect(
                harness.request(otherSession).runs.trigger({
                    testCaseId: testCase.id,
                    snapshotId,
                }),
            ).rejects.toThrowError();
        });
    },
});
