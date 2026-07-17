import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { AnalysisCandidateFinding } from "@autonoma/workflow/activities";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { type AnalysisDedupe, reconcileAnalysis } from "../../src/activities/analysis/reconcile-analysis";

// The holistic dedup runs a live model in prod (tested hermetically in @autonoma/diffs). These integration tests
// inject a deterministic dedup so they exercise the Reconciler's persistence + verdict derivation without a model
// or network.
const identityDedupe: AnalysisDedupe = async (candidates) =>
    candidates.map((candidate) => ({
        category: candidate.category,
        headline: candidate.headline,
        coveredSlugs: [candidate.slug],
        members: [candidate],
    }));

/** A dedup that merges the named slugs into one client_bug finding and leaves the rest standalone. */
function mergingDedupe(mergedSlugs: string[]): AnalysisDedupe {
    return async (candidates) => {
        const merged = candidates.filter((candidate) => mergedSlugs.includes(candidate.slug));
        const standalone = candidates.filter((candidate) => !mergedSlugs.includes(candidate.slug));
        const findings = standalone.map((candidate) => ({
            category: candidate.category,
            headline: candidate.headline,
            coveredSlugs: [candidate.slug],
            members: [candidate],
        }));
        if (merged.length > 0) {
            findings.unshift({
                category: "client_bug",
                headline: "Shared auth defect",
                coveredSlugs: merged.map((candidate) => candidate.slug),
                members: merged,
            });
        }
        return findings;
    };
}

const candidate = (
    slug: string,
    category: AnalysisCandidateFinding["category"],
    planEdited = false,
    origin: AnalysisCandidateFinding["origin"] = "pre_existing",
): AnalysisCandidateFinding => ({
    slug,
    category,
    headline: `${slug} headline`,
    planEdited,
    origin,
});

// reconcileAnalysis reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma).
// Point it at this suite's container so the activity and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";

/** Monotonic counter for unique slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

class ReconcileHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<ReconcileHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new ReconcileHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a detached twin snapshot (+ its org/app/branch). Each case makes its own to avoid cross-leaking. */
    async seedTwin(headSha?: string): Promise<{ snapshotId: string; organizationId: string }> {
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
        const twin = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH", headSha },
        });
        return { snapshotId: twin.id, organizationId: org.id };
    }
}

integrationTestSuite({
    name: "reconcileAnalysis (shadow store)",
    createHarness: () => ReconcileHarness.create(),
    cases: (test) => {
        test("persists deduped findings with unioned evidence and files nothing user-facing", async ({ harness }) => {
            const { snapshotId, organizationId } = await harness.seedTwin("sha-mixed");

            const result = await reconcileAnalysis(
                {
                    snapshotId,
                    mode: "shadow",
                    candidates: [
                        candidate("checkout", "passed"),
                        candidate("login", "client_bug"),
                        candidate("auth", "client_bug"),
                    ],
                },
                mergingDedupe(["login", "auth"]),
            );

            expect(result.verdict).toBe("client_bug");
            // testCount is the raw candidate count; findingCount is the deduped count (login+auth unioned).
            expect(result.testCount).toBe(3);
            expect(result.findingCount).toBe(2);
            expect(result.clientBugCount).toBe(1);
            expect(result.filedCount).toBe(0);
            // No diffs job exists for this head sha, so the comparison degrades to "not found".
            expect(result.comparison.found).toBe(false);

            const row = await harness.db.analysisShadowRun.findUnique({ where: { snapshotId } });
            expect(row?.mode).toBe("shadow");
            expect(row?.verdict).toBe("client_bug");
            expect(row?.testCount).toBe(3);
            expect(row?.clientBugCount).toBe(1);
            expect(row?.findings).toHaveLength(2);
            const mergedFinding = row?.findings?.find((finding) => finding.coveredSlugs.length > 1);
            expect(mergedFinding?.coveredSlugs).toEqual(["login", "auth"]);
            expect(mergedFinding?.members).toHaveLength(2);
            expect(row?.deployed).toEqual({ found: false, deployedTestCount: 0 });

            // The shadow store is not the user-facing Bug model - a shadow run must never file one.
            expect(await harness.db.bug.count({ where: { organizationId } })).toBe(0);
        });

        test("persists each member's planEdited + origin data tags to the shadow store", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-edited");

            await reconcileAnalysis(
                {
                    snapshotId,
                    mode: "shadow",
                    candidates: [
                        candidate("healed", "passed", true, "pre_existing"),
                        candidate("unestablished", "delete", false, "proposed"),
                    ],
                },
                identityDedupe,
            );

            const row = await harness.db.analysisShadowRun.findUnique({ where: { snapshotId } });
            const bySlug = new Map(
                (row?.findings ?? []).flatMap((finding) =>
                    finding.members.map(
                        (member) => [member.slug, { planEdited: member.planEdited, origin: member.origin }] as const,
                    ),
                ),
            );
            expect(bySlug.get("healed")).toEqual({ planEdited: true, origin: "pre_existing" });
            expect(bySlug.get("unestablished")).toEqual({ planEdited: false, origin: "proposed" });
        });

        test("resolves a `passed` verdict when no finding is a client bug", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-clean");

            const result = await reconcileAnalysis(
                { snapshotId, mode: "shadow", candidates: [candidate("home", "passed")] },
                identityDedupe,
            );

            expect(result.verdict).toBe("passed");
            expect(result.clientBugCount).toBe(0);
            const row = await harness.db.analysisShadowRun.findUnique({ where: { snapshotId } });
            expect(row?.verdict).toBe("passed");
        });

        test("an empty target set yields a `passed` verdict with zero findings", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin();

            const result = await reconcileAnalysis({ snapshotId, mode: "shadow", candidates: [] }, identityDedupe);

            expect(result.verdict).toBe("passed");
            expect(result.testCount).toBe(0);
            expect(result.findingCount).toBe(0);
            const row = await harness.db.analysisShadowRun.findUnique({ where: { snapshotId } });
            expect(row?.testCount).toBe(0);
            expect(row?.findings).toEqual([]);
        });
    },
});
