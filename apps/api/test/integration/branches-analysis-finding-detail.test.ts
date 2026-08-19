import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

apiTestSuite({
    name: "branches.analysisFindingDetail",
    cases: (test) => {
        test("returns the verdict story, live steps and plan for a judged finding", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "checkout-submit",
                    category: "client_bug",
                    headline: "Submit never enables",
                    classification: {
                        expectedBehavior: "Submit enables once the form is valid.",
                        actualBehavior: "Submit stays disabled.",
                        confidence: "high",
                        screenshotKey: "s3://bucket/key-frame.png",
                        evidence: [{ source: "code", detail: "The submit handler early-returns.", file: "cart.ts" }],
                    },
                },
            ]);
            const findingId = findingFor("checkout-submit");
            const generationId = await currentGenerationId(harness, findingId);
            await seedSteps(harness, generationId, [
                { order: 1, interaction: "click", status: "success", output: { point: { x: 12, y: 34 } } },
                { order: 2, interaction: "verify", status: "failed", error: "Button still disabled" },
            ]);

            const detail = await harness.request().branches.analysisFindingDetail({ findingId });

            expect(detail).not.toBeNull();
            expect(detail?.testCase.slug).toBe("checkout-submit");
            expect(detail?.classification).toMatchObject({
                category: "client_bug",
                headline: "Submit never enables",
                expectedBehavior: "Submit enables once the form is valid.",
                confidence: "high",
            });
            expect(detail?.classification?.keyScreenshotUrl).toBeDefined();
            expect(detail?.classification?.evidence).toHaveLength(1);
            expect(detail?.iterations.map((entry) => entry.number)).toEqual([1]);
            expect(detail?.generation?.id).toBe(generationId);
            expect(detail?.generation?.completedAt).toBeDefined();
            expect(detail?.generation?.steps.map((step) => step.order)).toEqual([1, 2]);
            expect(detail?.generation?.steps[0]?.overlayPoints).toEqual([{ x: 12, y: 34, role: "click" }]);
            expect(detail?.generation?.steps[1]?.error).toBe("Button still disabled");
            expect(detail?.plan).toBe("checkout-submit plan");
        });

        test("surfaces a generation's system failure so the drawer can explain a never-run test", async ({
            harness,
        }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "documents-upload",
                    category: "engine_artifact",
                    headline: "Scenario setup failed before the app was exercised",
                },
            ]);
            const findingId = findingFor("documents-upload");
            const generationId = await currentGenerationId(harness, findingId);
            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: {
                    status: "failed",
                    failure: { kind: "scenario_setup", message: "SDK returned HTTP 400: no factory registered." },
                },
            });

            const detail = await harness.request().branches.analysisFindingDetail({ findingId });

            expect(detail?.generation?.failure).toEqual({
                kind: "scenario_setup",
                message: "SDK returned HTTP 400: no factory registered.",
            });
        });

        test("selects a superseded iteration together with the generation it judged", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                {
                    slug: "cart-badge",
                    category: "passed",
                    headline: "Correct after the rewrite",
                    superseded: [{ category: "plan_mismatch", headline: "Asserts the old copy" }],
                },
            ]);
            const findingId = findingFor("cart-badge");

            const current = await harness.request().branches.analysisFindingDetail({ findingId });
            const superseded = await harness.request().branches.analysisFindingDetail({ findingId, iteration: 1 });

            expect(current?.classification?.category).toBe("passed");
            expect(current?.selfHealed).toBe(true);
            expect(current?.iterations.map((entry) => [entry.number, entry.category])).toEqual([
                [1, "plan_mismatch"],
                [2, "passed"],
            ]);
            expect(superseded?.classification?.category).toBe("plan_mismatch");
            expect(superseded?.generation?.id).toBeDefined();
            expect(superseded?.generation?.id).not.toBe(current?.generation?.id);
        });

        test("serves an unjudged finding from its live generation", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const { findingId, generationId } = await seedUnjudgedFinding(harness, snapshotId, "promo-code");
            await seedSteps(harness, generationId, [
                { order: 1, interaction: "navigate", status: "success" },
                { order: 2, interaction: "type", status: "success" },
            ]);

            const detail = await harness.request().branches.analysisFindingDetail({ findingId });

            expect(detail).not.toBeNull();
            expect(detail?.classification).toBeUndefined();
            expect(detail?.iterations).toEqual([]);
            expect(detail?.generation?.id).toBe(generationId);
            expect(detail?.generation?.status).toBe("running");
            expect(detail?.generation?.completedAt).toBeUndefined();
            expect(detail?.generation?.steps).toHaveLength(2);
            expect(detail?.plan).toBe("promo-code live plan");
        });

        test("gates the debug bundle and observability links on the admin role", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                { slug: "wishlist-sync", category: "passed" },
            ]);
            const findingId = findingFor("wishlist-sync");

            const asMember = await harness.request().branches.analysisFindingDetail({ findingId });
            harness.user = await harness.db.user.update({ where: { id: harness.userId }, data: { role: "admin" } });
            const asAdmin = await harness.request().branches.analysisFindingDetail({ findingId });

            expect(asMember?.generation?.debug).toBeUndefined();
            expect(asAdmin?.generation?.debug).toBeDefined();
        });

        test("returns null for an unknown finding and an unknown iteration", async ({ harness }) => {
            const { snapshotId } = await createAuthoritativeSnapshot(harness);
            const findingFor = await seedAnalysisFindings(harness.db, snapshotId, [
                { slug: "order-history", category: "passed" },
            ]);

            const unknownFinding = await harness.request().branches.analysisFindingDetail({ findingId: "nope" });
            const unknownIteration = await harness
                .request()
                .branches.analysisFindingDetail({ findingId: findingFor("order-history"), iteration: 7 });

            expect(unknownFinding).toBeNull();
            expect(unknownIteration).toBeNull();
        });
    },
});

/** An active snapshot with an AnalysisJob - the shape an analysis run leaves behind. */
async function createAuthoritativeSnapshot(harness: APITestHarness): Promise<{ snapshotId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `Finding Detail ${crypto.randomUUID()}`,
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
        data: { snapshotId: branch.activeSnapshotId, status: "running", organizationId: harness.organizationId },
    });

    return { snapshotId: branch.activeSnapshotId };
}

/** The generation pinned by the finding's current classification. */
async function currentGenerationId(harness: APITestHarness, findingId: string): Promise<string> {
    const finding = await harness.db.analysisFinding.findUniqueOrThrow({
        where: { id: findingId },
        select: { currentClassification: { select: { generationId: true } } },
    });
    if (finding.currentClassification == null) throw new Error("Expected a current classification");
    return finding.currentClassification.generationId;
}

interface SeedStep {
    order: number;
    interaction: string;
    status: "success" | "failed";
    output?: object;
    error?: string;
}

async function seedSteps(harness: APITestHarness, generationId: string, steps: SeedStep[]): Promise<void> {
    for (const step of steps) {
        await harness.db.stepAttempt.create({
            data: {
                generationId,
                order: step.order,
                interaction: step.interaction,
                status: step.status,
                output: step.output,
                error: step.error,
                params: { locator: `step-${step.order}` },
                screenshotBefore: `s3://bucket/${generationId}-${step.order}-before.png`,
                organizationId: harness.organizationId,
            },
        });
    }
}

/** A finding born at selection with a running generation - the mid-run shape before any classification. */
async function seedUnjudgedFinding(
    harness: APITestHarness,
    snapshotId: string,
    slug: string,
): Promise<{ findingId: string; generationId: string }> {
    const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branch: { select: { applicationId: true, organizationId: true } } },
    });
    const { applicationId, organizationId } = snapshot.branch;
    const folder = await harness.db.folder.create({
        data: { name: `Flow ${slug}`, applicationId, organizationId },
    });
    const testCase = await harness.db.testCase.create({
        data: { name: slug, slug, applicationId, folderId: folder.id, organizationId },
        select: { id: true },
    });
    const finding = await harness.db.analysisFinding.create({
        data: { reportSnapshotId: snapshotId, testCaseId: testCase.id, organizationId, origin: "pre_existing" },
        select: { id: true },
    });
    const plan = await harness.db.testPlan.create({
        data: { testCaseId: testCase.id, prompt: `${slug} live plan`, organizationId },
        select: { id: true },
    });
    const generation = await harness.db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId, status: "running" },
        select: { id: true },
    });
    return { findingId: finding.id, generationId: generation.id };
}
