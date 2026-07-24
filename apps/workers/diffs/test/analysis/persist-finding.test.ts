import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { AnalysisCandidateFinding } from "@autonoma/workflow/activities";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { persistAnalysisFinding } from "../../src/activities/analysis/persist-finding";

// persistAnalysisFinding reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma).
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";

let seq = 0;
const next = () => seq++;

const candidate = (
    slug: string,
    category: AnalysisCandidateFinding["category"],
    overrides: Partial<AnalysisCandidateFinding> = {},
): AnalysisCandidateFinding => ({
    slug,
    category,
    headline: `${slug} headline`,
    planEdited: false,
    origin: "pre_existing",
    ...overrides,
});

class PersistHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<PersistHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new PersistHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a snapshot with the up-front AnalysisJob an Investigator persists its findings against (no report). */
    async seedRun(): Promise<{ snapshotId: string; organizationId: string }> {
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
        // A finding FKs only the AnalysisJob, so the seed creates just the job (the Reporter authors the report
        // later); this exercises findings persisting during fan-out before any report exists.
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, organizationId: org.id, status: "running", startedAt: new Date() },
        });
        return { snapshotId: snapshot.id, organizationId: org.id };
    }
}

integrationTestSuite({
    name: "persistAnalysisFinding (investigator-owned finding store)",
    createHarness: () => PersistHarness.create(),
    cases: (test) => {
        test("persists a client bug's columns, rich evidence, and per-test provenance", async ({ harness }) => {
            const { snapshotId } = await harness.seedRun();

            await persistAnalysisFinding({
                snapshotId,
                finding: candidate("checkout", "client_bug", {
                    planEdited: true,
                    selectionReason: "The diff touches checkout total.",
                    selfHealNote: "Rewrote the plan.",
                    report: {
                        expectedBehavior: "the order completes",
                        actualBehavior: "the submit 500s",
                        screenshotKey: "s3://frames/checkout.png",
                    },
                }),
            });

            const finding = await harness.db.analysisFinding.findUnique({
                where: { reportSnapshotId_findingKey: { reportSnapshotId: snapshotId, findingKey: "checkout" } },
            });
            expect(finding?.category).toBe("client_bug");
            expect(finding?.slug).toBe("checkout");
            expect(finding?.planEdited).toBe(true);
            expect(finding?.selectionReason).toBe("The diff touches checkout total.");
            expect(finding?.selfHealNote).toBe("Rewrote the plan.");
            expect(finding?.expectedBehavior).toBe("the order completes");
            expect(finding?.screenshotKey).toBe("s3://frames/checkout.png");
            // A client bug sorts first in the findings list.
            expect(finding?.displayOrder).toBe(0);
        });

        test("is idempotent - a re-file upserts on (report, slug) and overwrites the prior verdict", async ({
            harness,
        }) => {
            const { snapshotId } = await harness.seedRun();

            await persistAnalysisFinding({ snapshotId, finding: candidate("login", "client_bug") });
            await persistAnalysisFinding({
                snapshotId,
                finding: candidate("login", "passed", { headline: "login works now" }),
            });

            const rows = await harness.db.analysisFinding.findMany({ where: { reportSnapshotId: snapshotId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.category).toBe("passed");
            expect(rows[0]?.headline).toBe("login works now");
            // A passing app-health check sorts after bugs.
            expect(rows[0]?.displayOrder).toBe(1);
        });

        test("sorts a coverage-plane finding last", async ({ harness }) => {
            const { snapshotId } = await harness.seedRun();

            await persistAnalysisFinding({ snapshotId, finding: candidate("flake", "engine_artifact") });

            const finding = await harness.db.analysisFinding.findUnique({
                where: { reportSnapshotId_findingKey: { reportSnapshotId: snapshotId, findingKey: "flake" } },
            });
            expect(finding?.displayOrder).toBe(2);
        });
    },
});
