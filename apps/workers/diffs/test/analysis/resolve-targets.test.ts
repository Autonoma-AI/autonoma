import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { logger as rootLogger } from "@autonoma/logger";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { type MaterializedTarget, resolveTargets } from "../../src/analysis/resolve-targets";
import { seedGenerationForSlug } from "./seed-generation";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:18-alpine";
const logger = rootLogger.child({ name: "resolveTargets.test" });

let seq = 0;
const next = () => seq++;

/** The application + snapshot a materialized generation belongs to. */
interface SeedContext {
    applicationId: string;
    organizationId: string;
    snapshotId: string;
}

class ResolveTargetsHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<ResolveTargetsHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new ResolveTargetsHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** A queued generation for one test on a fresh snapshot, as Impact Analysis would have materialized it. */
    async seedMaterialized(
        slug: string,
        architecture: ApplicationArchitecture = ApplicationArchitecture.WEB,
    ): Promise<MaterializedTarget> {
        const context = await this.seedContext(architecture);
        return await this.seedGeneration(context, slug);
    }

    /** Two generations queued for the SAME test, which is what a failed upstream guard leaves behind. */
    async seedTwoGenerationsForOneTest(slug: string): Promise<MaterializedTarget[]> {
        const context = await this.seedContext(ApplicationArchitecture.WEB);
        return [await this.seedGeneration(context, slug), await this.seedGeneration(context, slug)];
    }

    private async seedContext(architecture: ApplicationArchitecture): Promise<SeedContext> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}`, organizationId: org.id, architecture },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        return { applicationId: app.id, organizationId: org.id, snapshotId: snapshot.id };
    }

    private async seedGeneration(context: SeedContext, slug: string): Promise<MaterializedTarget> {
        const { generationId } = await seedGenerationForSlug(this.db, { ...context, slug });
        return { generationId, reason: `${slug} is affected`, origin: "pre_existing" };
    }
}

integrationTestSuite({
    name: "resolveTargets",
    createHarness: () => ResolveTargetsHarness.create(),
    cases: (test) => {
        test("resolves a materialized generation to its Investigator target", async ({ harness }) => {
            const materialized = await harness.seedMaterialized("checkout");

            const targets = await resolveTargets([materialized], logger);

            expect(targets).toHaveLength(1);
            expect(targets[0]?.slug).toBe("checkout");
            expect(targets[0]?.testGenerationId).toBe(materialized.generationId);
            expect(targets[0]?.origin).toBe("pre_existing");
        });

        test("returns no targets when nothing was materialized", async () => {
            expect(await resolveTargets([], logger)).toEqual([]);
        });

        test("fails rather than dropping a target whose generation was deleted", async ({ harness }) => {
            const materialized = await harness.seedMaterialized("checkout");
            await harness.db.testGeneration.delete({ where: { id: materialized.generationId } });

            await expect(resolveTargets([materialized], logger)).rejects.toThrow(/was deleted/);
        });

        // Two Investigators on one test would race for its single `(snapshot, testCase)` finding row.
        test("investigates a test once even when two generations were queued for it", async ({ harness }) => {
            const materialized = await harness.seedTwoGenerationsForOneTest("checkout");

            const targets = await resolveTargets(materialized, logger);

            expect(targets).toHaveLength(1);
            expect(targets[0]?.testGenerationId).toBe(materialized[0]?.generationId);
        });

        test("fails rather than dropping a non-web target", async ({ harness }) => {
            const materialized = await harness.seedMaterialized("checkout", ApplicationArchitecture.ANDROID);

            await expect(resolveTargets([materialized], logger)).rejects.toThrow(/non-web application/);
        });
    },
});
