import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { AnalysisFindingReport } from "@autonoma/types";
import type { AnalysisCandidateFinding } from "@autonoma/workflow/activities";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import {
    type AnalysisDedupe,
    type AnalysisNarrator,
    reconcileAnalysis,
} from "../../src/activities/analysis/reconcile-analysis";

// The holistic dedup + narration run live models in prod (tested hermetically in @autonoma/diffs). These
// integration tests inject a deterministic dedup + narration so they exercise the Reconciler's persistence,
// two-plane verdict derivation, and narration storage without a model or network.
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

/** A narrator that produces no narration - the default for cases not asserting narration behavior. */
const noopNarrate: AnalysisNarrator = async () => undefined;

/** A narrator that always returns the given prose - used to assert narration is stored verbatim. */
function fixedNarrate(text: string): AnalysisNarrator {
    return async () => text;
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
    name: "reconcileAnalysis (rich store)",
    createHarness: () => ReconcileHarness.create(),
    cases: (test) => {
        test("persists deduped findings with unioned coverage", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-mixed");

            const result = await reconcileAnalysis(
                {
                    snapshotId,
                    candidates: [
                        candidate("checkout", "passed"),
                        candidate("login", "client_bug"),
                        candidate("auth", "client_bug"),
                    ],
                },
                { dedupe: mergingDedupe(["login", "auth"]), narrate: noopNarrate },
            );

            expect(result.verdict).toBe("client_bug");
            // testCount is the raw candidate count; findingCount is the deduped count (login+auth unioned).
            expect(result.testCount).toBe(3);
            expect(result.findingCount).toBe(2);
            expect(result.clientBugCount).toBe(1);

            const report = await harness.db.analysisReport.findUnique({
                where: { snapshotId },
                include: { findings: true },
            });
            expect(report?.verdict).toBe("client_bug");
            expect(report?.testCount).toBe(3);
            expect(report?.clientBugCount).toBe(1);
            expect(report?.findings).toHaveLength(2);
            // The merged finding carries its union in coveredSlugs (set only when > 1); its anchor slug is `login`.
            const mergedFinding = report?.findings.find((finding) => finding.coveredSlugs != null);
            expect(mergedFinding?.coveredSlugs).toEqual(["login", "auth"]);
            expect(mergedFinding?.slug).toBe("login");
            expect(mergedFinding?.category).toBe("client_bug");
        });

        test("persists each finding's planEdited + origin data tags as columns", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-edited");

            await reconcileAnalysis(
                {
                    snapshotId,
                    candidates: [
                        candidate("healed", "passed", true, "pre_existing"),
                        candidate("unestablished", "delete", false, "proposed"),
                    ],
                },
                { dedupe: identityDedupe, narrate: noopNarrate },
            );

            const report = await harness.db.analysisReport.findUnique({
                where: { snapshotId },
                include: { findings: true },
            });
            const bySlug = new Map(
                (report?.findings ?? []).map(
                    (finding) => [finding.slug, { planEdited: finding.planEdited, origin: finding.origin }] as const,
                ),
            );
            expect(bySlug.get("healed")).toEqual({ planEdited: true, origin: "pre_existing" });
            expect(bySlug.get("unestablished")).toEqual({ planEdited: false, origin: "proposed" });
        });

        test("persists the Impact Analysis reasoning onto the report", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-reasoning");

            await reconcileAnalysis(
                {
                    snapshotId,
                    candidates: [candidate("home", "passed")],
                    impactReasoning: "The diff touches the checkout total calculation.",
                },
                { dedupe: identityDedupe, narrate: noopNarrate },
            );

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId } });
            expect(report?.impactReasoning).toBe("The diff touches the checkout total calculation.");
        });

        test("keeps a coverage-only run on the passed plane and summarizes the coverage counts + delete split", async ({
            harness,
        }) => {
            const { snapshotId } = await harness.seedTwin("sha-coverage");

            const result = await reconcileAnalysis(
                {
                    snapshotId,
                    candidates: [
                        candidate("flake", "engine_artifact"),
                        candidate("seed", "scenario_issue"),
                        candidate("gone-new", "delete", false, "proposed"),
                        candidate("gone-old", "delete", false, "pre_existing"),
                        candidate("gone-new-2", "delete", false, "proposed"),
                    ],
                },
                { dedupe: identityDedupe, narrate: noopNarrate },
            );

            // Coverage-plane findings never count as a bug - the app-health headline stays `passed`.
            expect(result.verdict).toBe("passed");
            expect(result.clientBugCount).toBe(0);
            expect(result.coverageFindingCount).toBe(5);
            expect(result.unestablishedProposedCount).toBe(2);
            expect(result.obsoleteRemovedCount).toBe(1);

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId } });
            expect(report?.verdict).toBe("passed");
            expect(report?.coverage?.total).toBe(5);
            expect(report?.coverage?.unestablishedProposed).toBe(2);
            expect(report?.coverage?.obsoleteRemoved).toBe(1);
            // byCategory is derived from the verdict SSOT order, coverage plane only, zero-count categories omitted.
            expect(report?.coverage?.byCategory).toEqual([
                { category: "engine_artifact", count: 1 },
                { category: "scenario_issue", count: 1 },
                { category: "delete", count: 3 },
            ]);
        });

        test("stores the narration and it never alters the verdict", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-narrate");
            const narration = "IGNORED CLAIM: a critical client bug was found.";

            const result = await reconcileAnalysis(
                { snapshotId, candidates: [candidate("home", "passed")] },
                { dedupe: identityDedupe, narrate: fixedNarrate(narration) },
            );

            // The narration is prose only - a contradictory claim must not flip the deterministic verdict.
            expect(result.verdict).toBe("passed");
            expect(result.narrated).toBe(true);

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId } });
            expect(report?.narration).toBe(narration);
            expect(report?.verdict).toBe("passed");
        });

        test("resolves a `passed` verdict when no finding is a client bug", async ({ harness }) => {
            const { snapshotId } = await harness.seedTwin("sha-clean");

            const result = await reconcileAnalysis(
                { snapshotId, candidates: [candidate("home", "passed")] },
                { dedupe: identityDedupe, narrate: noopNarrate },
            );

            expect(result.verdict).toBe("passed");
            expect(result.clientBugCount).toBe(0);
            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId } });
            expect(report?.verdict).toBe("passed");
        });

        test("an empty target set yields a `passed` verdict with zero findings and no narration", async ({
            harness,
        }) => {
            const { snapshotId } = await harness.seedTwin();

            const result = await reconcileAnalysis(
                { snapshotId, candidates: [] },
                { dedupe: identityDedupe, narrate: noopNarrate },
            );

            expect(result.verdict).toBe("passed");
            expect(result.testCount).toBe(0);
            expect(result.findingCount).toBe(0);
            expect(result.coverageFindingCount).toBe(0);
            expect(result.narrated).toBe(false);
            const report = await harness.db.analysisReport.findUnique({
                where: { snapshotId },
                include: { findings: true },
            });
            expect(report?.testCount).toBe(0);
            expect(report?.findings).toEqual([]);
            expect(report?.narration).toBeNull();
        });

        test("files no Bug/Issue - a client bug lives in AnalysisFinding with its evidence", async ({ harness }) => {
            const { snapshotId, organizationId } = await harness.seedTwin("sha-nofile");
            const report: AnalysisFindingReport = {
                whatHappened: "The total showed $0.",
                rootCause: "The subtotal was not summed.",
                screenshotKey: "s3://frames/key.png",
                clipKey: "s3://clips/clip.gif",
                classificationConversationUrl: "s3://diffs-job/snap/classify-checkout-conversation.json",
            };
            // The dedup carries the classifier's rich report onto the finding (identityDedupe drops it otherwise).
            const dedupeWithReport: AnalysisDedupe = async (candidates) =>
                candidates.map((c) => ({
                    category: c.category,
                    headline: c.headline,
                    coveredSlugs: [c.slug],
                    members: [c],
                    report: c.category === "client_bug" ? report : undefined,
                }));

            const result = await reconcileAnalysis(
                { snapshotId, candidates: [candidate("checkout", "client_bug")] },
                { dedupe: dedupeWithReport, narrate: noopNarrate },
            );

            expect(result.verdict).toBe("client_bug");
            expect(result.clientBugCount).toBe(1);

            // The analysis pipeline files NO user-facing rows - AnalysisFinding is the single source of truth.
            expect(await harness.db.bug.count({ where: { organizationId } })).toBe(0);
            expect(await harness.db.issue.count({ where: { organizationId } })).toBe(0);

            // The client bug lives on its AnalysisFinding row, carrying its full evidence + media keys.
            const stored = await harness.db.analysisReport.findUnique({
                where: { snapshotId },
                include: { findings: true },
            });
            const finding = stored?.findings.find((f) => f.slug === "checkout");
            expect(finding?.category).toBe("client_bug");
            expect(finding?.whatHappened).toBe("The total showed $0.");
            expect(finding?.screenshotKey).toBe("s3://frames/key.png");
            expect(finding?.clipKey).toBe("s3://clips/clip.gif");
            // The classifier conversation URL rides on the same row, keyed per slug, for finding-level debugging.
            expect(finding?.classificationConversationUrl).toBe(
                "s3://diffs-job/snap/classify-checkout-conversation.json",
            );
        });
    },
});
