import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import { expect } from "vitest";
import { type AgentSelection, materializeSelection } from "../../src/analysis/materialize-selection";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const logger = rootLogger.child({ name: "materializeSelection.test" });

let seq = 0;
const next = () => seq++;

interface SeededSuite {
    updater: TestSuiteUpdater;
    /** slug -> testCaseId for the tests the snapshot assigns, as the selection resolves them. */
    testCaseIdBySlug: Map<string, string>;
}

/** An `AgentSelection` with no created tests - only the affected-test half is under test here. */
function selection(
    testCaseIdBySlug: Map<string, string>,
    affectedTests: AgentSelection["affectedTests"],
): AgentSelection {
    return {
        reasoning: "the diff touches these",
        affectedTests,
        createdTests: [],
        flowFolderId: () => undefined,
        testCaseIdBySlug,
    };
}

class MaterializeHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<MaterializeHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new MaterializeHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** A snapshot mid-update with one assigned test, as Impact Analysis finds it. */
    async seedSuite(slug: string): Promise<SeededSuite> {
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
        const folder = await this.db.folder.create({
            data: { name: `Flow ${n}`, applicationId: app.id, organizationId: org.id },
        });
        const testCase = await this.db.testCase.create({
            data: { name: slug, slug, applicationId: app.id, folderId: folder.id, organizationId: org.id },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: `${slug} plan`, organizationId: org.id },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH", status: "processing" },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });

        const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
            db: this.db,
            snapshotId: snapshot.id,
            organizationId: org.id,
        });
        return { updater, testCaseIdBySlug: new Map([[slug, testCase.id]]) };
    }
}

integrationTestSuite({
    name: "materializeSelection (affected tests)",
    createHarness: () => MaterializeHarness.create(),
    cases: (test) => {
        test("queues one generation for an affected test the snapshot assigns", async ({ harness }) => {
            const { updater, testCaseIdBySlug } = await harness.seedSuite("checkout");
            const agentResult = selection(testCaseIdBySlug, [
                { slug: "checkout", reasoning: "checkout copy changed", affectedReason: "code_change" },
            ]);

            const materialized = await materializeSelection({ updater, agentResult, logger });

            expect(materialized).toHaveLength(1);
            expect(materialized[0]?.origin).toBe("pre_existing");
        });

        test("materializes a duplicated affected test once", async ({ harness }) => {
            const { updater, testCaseIdBySlug } = await harness.seedSuite("checkout");
            const agentResult = selection(testCaseIdBySlug, [
                { slug: "checkout", reasoning: "first mark", affectedReason: "code_change" },
                { slug: "checkout", reasoning: "second mark", affectedReason: "code_change" },
            ]);

            const materialized = await materializeSelection({ updater, agentResult, logger });

            // A second generation for one test case deletes the first, so the duplicate would strand a target.
            expect(materialized).toHaveLength(1);
            const generations = await harness.db.testGeneration.count({
                where: { id: materialized[0]?.generationId },
            });
            expect(generations).toBe(1);
        });

        // The merge flow forwards a conflict whose slug the target snapshot never assigned (two merged sources adding
        // the same test with different plans). It reaches here unvalidated, and must not fail the whole main-branch run.
        test("queues nothing for a conflicting test the snapshot does not assign", async ({ harness }) => {
            const { updater, testCaseIdBySlug } = await harness.seedSuite("checkout");
            const agentResult = selection(testCaseIdBySlug, [
                { slug: "only-on-the-merged-branches", reasoning: "", affectedReason: "merge_conflict" },
            ]);

            expect(await materializeSelection({ updater, agentResult, logger })).toEqual([]);
        });

        test("fails for an agent-marked test the snapshot does not assign", async ({ harness }) => {
            const { updater, testCaseIdBySlug } = await harness.seedSuite("checkout");
            const agentResult = selection(testCaseIdBySlug, [
                { slug: "not-in-the-suite", reasoning: "invented", affectedReason: "code_change" },
            ]);

            await expect(materializeSelection({ updater, agentResult, logger })).rejects.toThrow(
                /is not in snapshot .* suite/,
            );
        });
    },
});
