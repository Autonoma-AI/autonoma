import { type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { TestAPI } from "vitest";

export interface SeededTest {
    applicationId: string;
    branchId: string;
    testCaseId: string;
    testPlanId: string;
    slug: string;
    organizationId: string;
}

export interface AnalyzedRunInput {
    test: SeededTest;
    /** The verdicts of the run's self-heal iterations, oldest first. The last one is the finding's current. */
    iterations: string[];
    at: Date;
}

export class PriorRunsHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<PriorRunsHarness> {
        return new PriorRunsHarness(createClient(await createTestDatabase()));
    }

    async beforeAll() {}

    async afterAll() {
        await this.db.$disconnect();
    }

    async beforeEach() {}

    async afterEach() {}

    async seedTest(slug = `test-${crypto.randomUUID()}`): Promise<SeededTest> {
        const organization = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        const application = await this.db.application.create({
            data: {
                name: `App ${crypto.randomUUID()}`,
                slug: `app-${crypto.randomUUID()}`,
                organizationId: organization.id,
                architecture: "WEB",
            },
        });
        const branch = await this.db.branch.create({
            data: {
                name: `branch-${crypto.randomUUID()}`,
                organizationId: organization.id,
                applicationId: application.id,
            },
        });
        const folder = await this.db.folder.create({
            data: { name: "Default", applicationId: application.id, organizationId: organization.id },
        });
        const testCase = await this.db.testCase.create({
            data: {
                name: "Checkout works",
                slug,
                applicationId: application.id,
                folderId: folder.id,
                organizationId: organization.id,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: "Do the thing.", organizationId: organization.id },
        });
        return {
            applicationId: application.id,
            branchId: branch.id,
            testCaseId: testCase.id,
            testPlanId: plan.id,
            slug,
            organizationId: organization.id,
        };
    }

    /**
     * One analysis run over the test, left in the shape `persistAnalysisClassification` leaves it: a finding
     * with one `AnalysisClassification` per self-heal iteration, pointed at the last. Returns the snapshot id
     * so a caller can ask for the baseline as of that run.
     */
    async recordAnalyzedRun({ test, iterations, at }: AnalyzedRunInput): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: test.branchId, source: "MANUAL", status: "active", baseSha: "base", headSha: "head" },
        });
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, status: "completed", organizationId: test.organizationId },
        });
        const finding = await this.db.analysisFinding.create({
            data: {
                reportSnapshotId: snapshot.id,
                testCaseId: test.testCaseId,
                organizationId: test.organizationId,
                createdAt: at,
            },
        });

        let currentClassificationId: string | undefined;
        for (const [index, category] of iterations.entries()) {
            const generation = await this.db.testGeneration.create({
                data: {
                    testPlanId: test.testPlanId,
                    snapshotId: snapshot.id,
                    organizationId: test.organizationId,
                    // Deliberately `success` on every iteration: the engine finishing says nothing about
                    // whether the app behaved, and the baseline must not read it as if it did.
                    status: "success",
                    createdAt: at,
                },
            });
            const classification = await this.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: index + 1,
                    generationId: generation.id,
                    category,
                    headline: `Iteration ${index + 1}: ${category}`,
                    organizationId: test.organizationId,
                    createdAt: at,
                },
            });
            currentClassificationId = classification.id;
        }

        await this.db.analysisFinding.update({ where: { id: finding.id }, data: { currentClassificationId } });
        return snapshot.id;
    }

    async recordUnjudgedRun(test: SeededTest, at: Date): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: test.branchId, source: "MANUAL", status: "active", baseSha: "base", headSha: "head" },
        });
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, status: "failed", organizationId: test.organizationId },
        });
        await this.db.analysisFinding.create({
            data: {
                reportSnapshotId: snapshot.id,
                testCaseId: test.testCaseId,
                organizationId: test.organizationId,
                createdAt: at,
            },
        });
        return snapshot.id;
    }
}

type PriorRunsSuiteContext = { harness: PriorRunsHarness; seedResult: undefined };

export function priorRunsSuite(params: { name: string; cases: (test: TestAPI<PriorRunsSuiteContext>) => void }) {
    integrationTestSuite<PriorRunsHarness, undefined>({
        name: params.name,
        createHarness: () => PriorRunsHarness.create(),
        seed: async () => undefined,
        cases: params.cases,
    });
}
