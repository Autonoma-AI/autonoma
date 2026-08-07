import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { openAnalysisRun } from "../../src/activities/analysis/open-analysis-run";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const HEAD_SHA = "head1111111111111111111111111111111111111";
const BASE_SHA = "base2222222222222222222222222222222222222";

let seq = 0;
const next = () => seq++;

interface SeedOptions {
    architecture?: ApplicationArchitecture;
    folders?: number;
}

class OpenRunHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<OpenRunHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new OpenRunHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** A branch on an application with the given architecture and folder count, and no snapshots yet. */
    async seedBranch(options: SeedOptions = {}): Promise<string> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: options.architecture ?? ApplicationArchitecture.WEB,
            },
        });
        for (let i = 0; i < (options.folders ?? 1); i++) {
            await this.db.folder.create({
                data: { name: `Flow ${i}`, applicationId: app.id, organizationId: org.id },
            });
        }
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        return branch.id;
    }

    async jobCount(branchId: string): Promise<number> {
        return await this.db.analysisJob.count({ where: { snapshot: { branchId } } });
    }
}

integrationTestSuite({
    name: "openAnalysisRun (application preconditions)",
    createHarness: () => OpenRunHarness.create(),
    cases: (test) => {
        test("opens the run for a web application that has folders", async ({ harness }) => {
            const branchId = await harness.seedBranch();

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result.skipped).toBe(false);
            expect(await harness.jobCount(branchId)).toBe(1);
        });

        test("refuses a non-web application without opening a run", async ({ harness }) => {
            const branchId = await harness.seedBranch({ architecture: ApplicationArchitecture.IOS });

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result).toEqual({ skipped: true, reason: "unsupported_architecture" });
            expect(await harness.jobCount(branchId)).toBe(0);
        });

        test("refuses an application with no folders without opening a run", async ({ harness }) => {
            const branchId = await harness.seedBranch({ folders: 0 });

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result).toEqual({ skipped: true, reason: "no_test_folders" });
            expect(await harness.jobCount(branchId)).toBe(0);
        });
    },
});
