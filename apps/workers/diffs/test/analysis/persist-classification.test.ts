import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { AnalysisCandidateClassification } from "@autonoma/workflow/activities";
import { expect } from "vitest";
import { persistAnalysisClassification } from "../../src/activities/analysis/persist-classification";
import { recordAnalysisContainment } from "../../src/activities/analysis/record-analysis-containment";

// persistAnalysisClassification reads the `@autonoma/db` singleton (the global `db` proxy resolves to
// globalThis.prisma).
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

let seq = 0;
const next = () => seq++;

const classification = (
    category: AnalysisCandidateClassification["category"],
    generationId: string,
    overrides: Partial<AnalysisCandidateClassification> = {},
): AnalysisCandidateClassification => ({
    generationId,
    category,
    headline: `${category} headline`,
    ...overrides,
});

interface SeededRun {
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    /** Two generations: a self-heal re-runs the test on a fresh one, and each classification pins the run it judged. */
    generationIds: [string, string];
}

class PersistHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<PersistHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new PersistHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /**
     * Seed a snapshot with the up-front AnalysisJob an Investigator persists against (no report), plus the test
     * case / plan / generations a classification points at - the generation FK is what makes a verdict resolvable
     * back to the run it judged.
     */
    async seedRun(): Promise<SeededRun> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        // The seed creates the job but no report (the Reporter authors that later); this exercises classifications
        // persisting during fan-out before any report exists.
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, organizationId: org.id, status: "running", startedAt: new Date() },
        });

        const folder = await this.db.folder.create({
            data: { name: `Flow ${n}`, applicationId: app.id, organizationId: org.id },
        });
        const testCase = await this.db.testCase.create({
            data: {
                name: `Test ${n}`,
                slug: `test-${n}`,
                applicationId: app.id,
                folderId: folder.id,
                organizationId: org.id,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: "seed plan", organizationId: org.id },
        });
        const generations = await Promise.all(
            [0, 1].map(() =>
                this.db.testGeneration.create({
                    data: {
                        testPlanId: plan.id,
                        snapshotId: snapshot.id,
                        organizationId: org.id,
                        status: "success",
                    },
                }),
            ),
        );
        const [first, second] = generations;
        if (first == null || second == null) throw new Error("seed failed to create both generations");

        return {
            snapshotId: snapshot.id,
            organizationId: org.id,
            testCaseId: testCase.id,
            generationIds: [first.id, second.id],
        };
    }
}

integrationTestSuite({
    name: "persistAnalysisClassification (per-iteration verdict store)",
    createHarness: () => PersistHarness.create(),
    cases: (test) => {
        test("creates the test's finding and files the iteration's verdict, evidence and provenance", async ({
            harness,
        }) => {
            const { snapshotId, testCaseId, generationIds } = await harness.seedRun();

            const result = await persistAnalysisClassification({
                snapshotId,
                testCaseId,
                origin: "pre_existing",
                selectionReason: "The diff touches checkout total.",
                number: 1,
                classification: classification("client_bug", generationIds[0], {
                    report: {
                        expectedBehavior: "the order completes",
                        actualBehavior: "the submit 500s",
                        screenshotKey: "s3://frames/checkout.png",
                        conversationUrl: "s3://conversations/classify-gen-1.json",
                    },
                }),
            });

            expect(result.number).toBe(1);
            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
                include: { currentClassification: true },
            });
            expect(finding.id).toBe(result.findingId);
            expect(finding.origin).toBe("pre_existing");
            expect(finding.selectionReason).toBe("The diff touches checkout total.");
            expect(finding.currentClassification?.category).toBe("client_bug");
            expect(finding.currentClassification?.generationId).toBe(generationIds[0]);
            expect(finding.currentClassification?.expectedBehavior).toBe("the order completes");
            expect(finding.currentClassification?.screenshotKey).toBe("s3://frames/checkout.png");
            expect(finding.currentClassification?.conversationUrl).toBe("s3://conversations/classify-gen-1.json");
        });

        // A self-heal classifies the same test twice. The FIRST verdict is the one that authored the plan rewrite,
        // so it must survive the re-run with its conversation, each pinned to the generation it judged.
        test("appends a second iteration instead of overwriting the verdict that motivated the self-heal", async ({
            harness,
        }) => {
            const { snapshotId, testCaseId, generationIds } = await harness.seedRun();

            await persistAnalysisClassification({
                snapshotId,
                testCaseId,
                origin: "pre_existing",
                number: 1,
                classification: classification("plan_mismatch", generationIds[0], {
                    headline: "The test asserts the old copy",
                    report: { conversationUrl: "s3://conversations/pass-1.json", plan: "assert -$350.00" },
                }),
            });
            const second = await persistAnalysisClassification({
                snapshotId,
                testCaseId,
                origin: "pre_existing",
                number: 2,
                classification: classification("plan_mismatch", generationIds[1], {
                    headline: "Still wrong after the rewrite",
                    report: { conversationUrl: "s3://conversations/pass-2.json", plan: "assert +$350.00" },
                }),
            });

            expect(second.number).toBe(2);
            const findings = await harness.db.analysisFinding.findMany({
                where: { reportSnapshotId: snapshotId },
                include: {
                    currentClassification: true,
                    classifications: { orderBy: { number: "asc" } },
                },
            });
            expect(findings).toHaveLength(1);
            const finding = findings[0];
            expect(finding?.classifications).toHaveLength(2);
            expect(finding?.currentClassification?.category).toBe("plan_mismatch");

            const [first, latest] = finding?.classifications ?? [];
            expect(first?.category).toBe("plan_mismatch");
            expect(first?.generationId).toBe(generationIds[0]);
            expect(first?.conversationUrl).toBe("s3://conversations/pass-1.json");
            expect(first?.plan).toBe("assert -$350.00");
            expect(latest?.conversationUrl).toBe("s3://conversations/pass-2.json");
            expect(latest?.plan).toBe("assert +$350.00");
        });

        // Several readers infer a self-heal from how many classifications a test has, so filing the same iteration
        // twice must not leave two rows behind - a re-execution would otherwise report a plan rewrite that never
        // happened, and put the test in the snapshot page's "Modified" section.
        test("re-filing the same iteration restates its row instead of appending a second one", async ({ harness }) => {
            const { snapshotId, testCaseId, generationIds } = await harness.seedRun();
            const file = async (headline: string) =>
                await persistAnalysisClassification({
                    snapshotId,
                    testCaseId,
                    origin: "pre_existing",
                    number: 1,
                    classification: classification("client_bug", generationIds[0], { headline }),
                });

            const first = await file("Submit never enables");
            const again = await file("Submit never enables");

            expect(again.findingId).toBe(first.findingId);
            expect(again.number).toBe(1);
            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
                include: { classifications: true },
            });
            expect(finding.classifications).toHaveLength(1);
        });

        // A contained fault (a crashed classifier, a scenario that never came up) has no classifier output at all.
        test("files a fault with its category alone, leaving the verdict fields empty", async ({ harness }) => {
            const { snapshotId, testCaseId, generationIds } = await harness.seedRun();

            await persistAnalysisClassification({
                snapshotId,
                testCaseId,
                origin: "proposed",
                number: 1,
                classification: classification("engine_artifact", generationIds[0], {
                    headline: "The Investigator crashed or timed out",
                }),
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
                include: { currentClassification: true },
            });
            expect(finding.currentClassification?.category).toBe("engine_artifact");
            expect(finding.currentClassification?.conversationUrl).toBeNull();
            expect(finding.currentClassification?.evidence).toBeNull();
        });

        // The fan-out parent contains a crashed child as a structured failure on the finding - never a fake
        // classification - so a child that crashed before filing anything leaves zero classifications and no run.
        test("a containment for a test with no run records a failure and no classification", async ({ harness }) => {
            const { snapshotId, organizationId } = await harness.seedRun();
            const folder = await harness.db.folder.findFirstOrThrow({
                where: { organizationId },
                select: { id: true, applicationId: true },
            });
            const untouched = await harness.db.testCase.create({
                data: {
                    name: "Never ran",
                    slug: `never-ran-${next()}`,
                    applicationId: folder.applicationId,
                    folderId: folder.id,
                    organizationId,
                },
            });
            const runCountBefore = await harness.db.testGeneration.count({ where: { snapshotId } });

            await recordAnalysisContainment({
                snapshotId,
                testCaseId: untouched.id,
                origin: "pre_existing",
                selectionReason: "The diff touches it.",
                message: "The Investigator crashed before starting",
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId: untouched.id } },
                include: { classifications: true },
            });
            expect(finding.failure).toEqual({
                kind: "investigator_crashed",
                message: "The Investigator crashed before starting",
            });
            expect(finding.classifications).toHaveLength(0);
            expect(finding.currentClassificationId).toBeNull();
            expect(finding.selectionReason).toBe("The diff touches it.");
            // No run is started to anchor the containment.
            expect(await harness.db.testGeneration.count({ where: { snapshotId } })).toBe(runCountBefore);
        });

        // A child that crashed mid-loop already filed an iteration; the containment records the crash without
        // displacing the verdict the child reached.
        test("a containment after a filed iteration keeps that verdict current", async ({ harness }) => {
            const { snapshotId, testCaseId, generationIds } = await harness.seedRun();
            await persistAnalysisClassification({
                snapshotId,
                testCaseId,
                origin: "pre_existing",
                number: 1,
                classification: classification("plan_mismatch", generationIds[0]),
            });

            await recordAnalysisContainment({
                snapshotId,
                testCaseId,
                origin: "pre_existing",
                message: "died during the self-heal re-run",
            });

            const finding = await harness.db.analysisFinding.findUniqueOrThrow({
                where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
                include: { currentClassification: true, classifications: true },
            });
            expect(finding.currentClassification?.category).toBe("plan_mismatch");
            expect(finding.classifications).toHaveLength(1);
            expect(finding.failure).toEqual({
                kind: "investigator_crashed",
                message: "died during the self-heal re-run",
            });
        });
    },
});
