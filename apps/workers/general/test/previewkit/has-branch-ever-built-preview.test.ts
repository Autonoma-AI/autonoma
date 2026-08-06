import { ApplicationArchitecture, applyMigrations, createClient, type PrismaClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { hasBranchEverBuiltPreview } from "../../src/activities/previewkit/has-branch-ever-built-preview";

// The activity reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so it and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:18-alpine";

/** Monotonic counter for unique names across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

class PreviewHistoryHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<PreviewHistoryHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new PreviewHistoryHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a branch, with an optional preview environment linked to it. */
    async seedBranch(environment?: { status: "building" | "ready"; deployed: boolean }): Promise<string> {
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
        if (environment == null) return branch.id;

        await this.db.previewkitEnvironment.create({
            data: {
                namespace: `preview-${n}`,
                repoFullName: `acme/repo-${n}`,
                prNumber: n + 1,
                headSha: `head-${n}`,
                headRef: `feature/${n}`,
                organizationId: org.id,
                branchId: branch.id,
                status: environment.status,
                deployedAt: environment.deployed ? new Date() : null,
            },
        });
        return branch.id;
    }
}

integrationTestSuite({
    name: "hasBranchEverBuiltPreview (the gate's one input)",
    createHarness: () => PreviewHistoryHarness.create(),
    cases: (test) => {
        test("is false for a branch with no preview environment at all", async ({ harness }) => {
            const branchId = await harness.seedBranch();

            expect(await hasBranchEverBuiltPreview({ branchId })).toEqual({ everBuilt: false });
        });

        test("is false while the branch's first build is still in flight", async ({ harness }) => {
            const branchId = await harness.seedBranch({ status: "building", deployed: false });

            expect(await hasBranchEverBuiltPreview({ branchId })).toEqual({ everBuilt: false });
        });

        test("is true once a preview has come up on the branch", async ({ harness }) => {
            const branchId = await harness.seedBranch({ status: "ready", deployed: true });

            expect(await hasBranchEverBuiltPreview({ branchId })).toEqual({ everBuilt: true });
        });

        // The case a status-only check would get wrong: a redeploy resets the environment row to `building`, but the
        // branch has had a live preview and must never be gated again.
        test("stays true while an established preview is mid-redeploy", async ({ harness }) => {
            const branchId = await harness.seedBranch({ status: "building", deployed: true });

            expect(await hasBranchEverBuiltPreview({ branchId })).toEqual({ everBuilt: true });
        });
    },
});
