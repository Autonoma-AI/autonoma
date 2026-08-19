import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { resolveMergeGateCheckResult } from "../../src/activities/analysis/apply-merge-gate-verdict";
import { loadAnalysisCommentInput } from "../../src/activities/analysis/load-analysis-comment-input";
import type { SnapshotMeta } from "../../src/codebase/snapshot-context";
import { seedAnalysisIssue, seedGenerationForSlug } from "./seed-generation";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const RUN_AT = new Date("2026-07-02T10:00:00Z");

let seq = 0;
const next = () => seq++;

interface SeededRun {
    meta: SnapshotMeta;
    snapshotId: string;
    branchId: string;
    organizationId: string;
}

interface SeedRunOptions {
    /** The branch's open bug issues, by title - one `client_bug` finding each, and what both surfaces must name. */
    openBugTitles: string[];
    /** Coverage-plane findings this run produced, seeded as engine artifacts. */
    coverageCount: number;
    /** Findings that confirmed the app. */
    passedCount: number;
}

/**
 * One settled analysis, seeded once and read back through both blocking surfaces.
 */
class CrossSurfaceHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<CrossSurfaceHarness> {
        const db = createClient(await createTestDatabase());
        globalThis.prisma = db;
        return new CrossSurfaceHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    async seedRun(options: SeedRunOptions): Promise<SeededRun> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-x-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-x-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/x-${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH", createdAt: RUN_AT, headSha: `sha-${n}` },
        });
        await this.db.analysisJob.create({
            data: {
                snapshotId: snapshot.id,
                organizationId: org.id,
                status: "completed",
                startedAt: RUN_AT,
                completedAt: RUN_AT,
            },
        });

        for (const [index, title] of options.openBugTitles.entries()) {
            const issueId = await seedAnalysisIssue(this.db, {
                branchId: branch.id,
                organizationId: org.id,
                title,
                kind: "bug",
                severity: "critical",
                actualBehavior: "It misbehaves.",
                narrativeMarkdown: "narrative",
            });
            await this.seedFinding({
                app,
                org,
                snapshot,
                slug: `bug-${index}`,
                category: "client_bug",
                issueId,
            });
        }

        for (let index = 0; index < options.coverageCount; index += 1) {
            await this.seedFinding({ app, org, snapshot, slug: `gap-${index}`, category: "engine_artifact" });
        }
        for (let index = 0; index < options.passedCount; index += 1) {
            await this.seedFinding({ app, org, snapshot, slug: `passed-${index}`, category: "passed" });
        }

        // Its existence marks the run settled; the counts are the findings' to answer.
        await this.db.analysisReport.create({
            data: {
                snapshotId: snapshot.id,
                organizationId: org.id,
                title: "The run",
                headline: "A headline.",
                reportMarkdown: "## Report",
            },
        });

        return {
            snapshotId: snapshot.id,
            branchId: branch.id,
            organizationId: org.id,
            meta: {
                snapshotId: snapshot.id,
                baseSha: "base",
                headSha: `sha-${n}`,
                createdAt: RUN_AT,
                organizationId: org.id,
                applicationId: app.id,
                appSlug: app.slug,
                clientName: org.name,
                branchId: branch.id,
                githubRepositoryId: 1,
                onboardingStep: undefined,
            },
        };
    }

    /** One test's finding for this run: a generation, its classification, and the verdict it stands behind. */
    private async seedFinding(input: {
        app: { id: string };
        org: { id: string };
        snapshot: { id: string };
        slug: string;
        category: string;
        issueId?: string;
    }): Promise<void> {
        const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
            applicationId: input.app.id,
            organizationId: input.org.id,
            snapshotId: input.snapshot.id,
            slug: input.slug,
        });
        const finding = await this.db.analysisFinding.create({
            data: {
                reportSnapshotId: input.snapshot.id,
                organizationId: input.org.id,
                testCaseId,
                issueId: input.issueId,
            },
        });
        const classification = await this.db.analysisClassification.create({
            data: {
                findingId: finding.id,
                number: 1,
                organizationId: input.org.id,
                generationId,
                category: input.category,
                headline: `${input.slug} headline`,
            },
        });
        await this.db.analysisFinding.update({
            where: { id: finding.id },
            data: { currentClassificationId: classification.id },
        });
    }
}

/**
 * The merge-gate check and the PR comment are the two surfaces that speak for a run in GitHub, and they share no
 * code but the analysis store. These pin that they cannot disagree about a snapshot: one blocking a merge over a
 * bug the other never lists is the failure they exist to catch.
 */
integrationTestSuite({
    name: "the merge-gate check and the PR comment cannot disagree about one snapshot",
    createHarness: () => CrossSurfaceHarness.create(),
    cases: (test) => {
        test("a run with open bugs fails the check and cards exactly those bugs in the comment", async ({
            harness,
        }) => {
            const run = await harness.seedRun({
                openBugTitles: ["Place order never enables", "Cart badge shows a stale count"],
                coverageCount: 1,
                passedCount: 0,
            });

            const [gate, comment] = await Promise.all([
                resolveMergeGateCheckResult(run.meta, { kind: "succeeded" }),
                loadAnalysisCommentInput(run.snapshotId),
            ]);

            expect(gate.result.conclusion).toBe("failure");
            // Same rows, same order (the shared severity comparator), on both surfaces.
            expect(gate.bugTitles).toEqual(comment?.bugIssues.map((issue) => issue.title));
            expect(comment?.bugIssues).toHaveLength(2);
            // Both render the ledger's one verdict, so neither can describe a different run.
            expect(comment?.verdict.state).toBe("bug_found");
            expect(comment?.verdict.investigatedCount).toBe(3);
            expect(comment?.coverage?.total).toBe(1);
        });

        test("a clean run passes the check and cards no bugs", async ({ harness }) => {
            const run = await harness.seedRun({
                openBugTitles: [],
                coverageCount: 0,
                passedCount: 2,
            });

            const [gate, comment] = await Promise.all([
                resolveMergeGateCheckResult(run.meta, { kind: "succeeded" }),
                loadAnalysisCommentInput(run.snapshotId),
            ]);

            expect(gate.result.conclusion).toBe("success");
            expect(gate.bugTitles).toEqual([]);
            expect(comment?.bugIssues).toEqual([]);
            expect(comment?.verdict.state).toBe("healthy");
        });

        test("a bug resolved after the report was written disappears from BOTH surfaces together", async ({
            harness,
        }) => {
            const run = await harness.seedRun({
                openBugTitles: ["Place order never enables"],
                coverageCount: 0,
                passedCount: 1,
            });
            // The ledger moved on: both surfaces read it live rather than trusting the frozen count.
            await harness.db.analysisIssue.updateMany({
                where: { branchId: run.branchId },
                data: { resolvedAt: new Date() },
            });

            const [gate, comment] = await Promise.all([
                resolveMergeGateCheckResult(run.meta, { kind: "succeeded" }),
                loadAnalysisCommentInput(run.snapshotId),
            ]);

            // The gate blocks on bugs that are open NOW, so a resolve un-blocks the merge on both surfaces at once.
            expect(gate.result.conclusion).not.toBe("failure");
            expect(gate.bugTitles).toEqual([]);
            expect(comment?.bugIssues).toEqual([]);
            expect(comment?.verdict.bugCount).toBe(0);
        });
    },
});
