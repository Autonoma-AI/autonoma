import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import type { ReporterIssueContent, ReporterIssueResult, ReporterResult } from "@autonoma/diffs/analysis";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { runReporter } from "../../src/activities/analysis/run-reporter";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";
let seq = 0;
const next = () => seq++;

/** A Reporter that returns a fixed result; the default clone+model path is bypassed. */
const fixedResult = (result: ReporterResult) => async () => result;
/** A Reporter that fails, exercising the failure path (which fails the run). */
const failingResult = () => async () => {
    throw new Error("reporter blew up");
};

function issueContent(title: string, findingSlugs: string[]): ReporterIssueContent {
    return {
        title,
        kind: "bug",
        severity: "high",
        actualBehavior: `${title} misbehaves`,
        narrativeMarkdown: `${title} narrative`,
        evidenceManifest: [],
        findingSlugs,
        primaryFindingSlug: findingSlugs[0] ?? "",
    };
}

interface SeededRun {
    snapshotId: string;
    organizationId: string;
    branchId: string;
}

class ReporterHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<ReporterHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new ReporterHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a run with only the up-front AnalysisJob + the given findings (slug -> category). The Reporter authors
     * the report itself, so the seed must NOT create one. */
    async seedRun(findings: Array<{ slug: string; category: string }>): Promise<SeededRun> {
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
        // A finding FKs the AnalysisJob (not the report - that is born later, from the Reporter).
        await this.db.analysisJob.create({
            data: { snapshotId: snapshot.id, organizationId: org.id, status: "running", startedAt: new Date() },
        });
        for (const [index, finding] of findings.entries()) {
            await this.db.analysisFinding.create({
                data: {
                    reportSnapshotId: snapshot.id,
                    organizationId: org.id,
                    findingKey: finding.slug,
                    slug: finding.slug,
                    category: finding.category,
                    headline: `${finding.slug} headline`,
                    displayOrder: index,
                },
            });
        }
        return { snapshotId: snapshot.id, organizationId: org.id, branchId: branch.id };
    }

    async seedOpenIssue(run: SeededRun, findingSlugs: string[]): Promise<string> {
        const issue = await this.db.analysisIssue.create({
            data: {
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Existing bug",
                kind: "bug",
                severity: "high",
                status: "open",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "existing narrative",
                findingSlugs,
            },
        });
        return issue.id;
    }
}

integrationTestSuite({
    name: "runReporter (issue reconciliation + report persistence)",
    createHarness: () => ReporterHarness.create(),
    cases: (test) => {
        test("opens a new issue, backfills the finding's issueId, and authors the report with a client_bug verdict", async ({
            harness,
        }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);

            const openAction: ReporterIssueResult = {
                kind: "open",
                content: issueContent("Checkout broken", ["checkout"]),
            };
            const result = await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nCheckout is broken.",
                        reportEvidenceManifest: [],
                        summary: "One bug: the app misbehaves.",
                        issues: [openAction],
                    }),
                },
            );

            expect(result).toEqual({
                issuesOpened: 1,
                issuesCarried: 0,
                issuesResolved: 0,
                verdict: "client_bug",
                clientBugCount: 1,
            });

            const issues = await harness.db.analysisIssue.findMany({ where: { branchId: run.branchId } });
            expect(issues).toHaveLength(1);
            expect(issues[0]?.kind).toBe("bug");
            expect(issues[0]?.status).toBe("open");
            expect(issues[0]?.findingSlugs).toEqual(["checkout"]);

            const finding = await harness.db.analysisFinding.findUnique({
                where: { reportSnapshotId_findingKey: { reportSnapshotId: run.snapshotId, findingKey: "checkout" } },
            });
            expect(finding?.issueId).toBe(issues[0]?.id);

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.reportMarkdown).toBe("## Report\nCheckout is broken.");
            expect(report?.verdict).toBe("client_bug");
            expect(report?.clientBugCount).toBe(1);
            expect(report?.testCount).toBe(1);
        });

        test("resolves an existing open issue whose covering test passed", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "login", category: "passed" }]);
            const existingId = await harness.seedOpenIssue(run, ["login"]);

            const result = await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nLogin works now.",
                        reportEvidenceManifest: [],
                        summary: "One bug: the app misbehaves.",
                        issues: [
                            {
                                kind: "resolve",
                                existingIssueId: existingId,
                                resolvingFindingSlug: "login",
                                note: "passes now",
                            },
                        ],
                    }),
                },
            );

            expect(result.issuesResolved).toBe(1);
            const issue = await harness.db.analysisIssue.findUnique({ where: { id: existingId } });
            expect(issue?.status).toBe("resolved");
            expect(issue?.resolvedAt).not.toBeNull();

            // Resolving the branch's only open bug flips the report green.
            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.verdict).toBe("passed");
            expect(report?.clientBugCount).toBe(0);
        });

        test("carries an existing issue forward, reopening it and unioning this job's slugs", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);
            const existingId = await harness.seedOpenIssue(run, ["profile"]);
            // Simulate a previously resolved regression to prove carry-forward reopens it.
            await harness.db.analysisIssue.update({
                where: { id: existingId },
                data: { status: "resolved", resolvedAt: new Date() },
            });

            const carry: ReporterIssueResult = {
                kind: "carry_forward",
                existingIssueId: existingId,
                content: issueContent("Checkout broken", ["checkout"]),
            };
            const result = await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nStill broken.",
                        reportEvidenceManifest: [],
                        summary: "One bug: the app misbehaves.",
                        issues: [carry],
                    }),
                },
            );

            expect(result.issuesCarried).toBe(1);
            const issue = await harness.db.analysisIssue.findUnique({ where: { id: existingId } });
            expect(issue?.status).toBe("open");
            expect(issue?.resolvedAt).toBeNull();
            expect(new Set(issue?.findingSlugs)).toEqual(new Set(["profile", "checkout"]));

            const finding = await harness.db.analysisFinding.findUnique({
                where: { reportSnapshotId_findingKey: { reportSnapshotId: run.snapshotId, findingKey: "checkout" } },
            });
            expect(finding?.issueId).toBe(existingId);

            // The reopened bug keeps the report red.
            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.verdict).toBe("client_bug");
            expect(report?.clientBugCount).toBe(1);
        });

        test("stays green with no open bug issues, counting coverage findings on the coverage plane", async ({
            harness,
        }) => {
            const run = await harness.seedRun([
                { slug: "login", category: "passed" },
                { slug: "flake", category: "engine_artifact" },
            ]);

            await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nAll green.",
                        reportEvidenceManifest: [],
                        summary: "One bug: the app misbehaves.",
                        issues: [],
                    }),
                },
            );

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.verdict).toBe("passed");
            expect(report?.clientBugCount).toBe(0);
            expect(report?.testCount).toBe(2);
            // `passed` is the app-health plane; only `engine_artifact` lands on the coverage plane.
            expect(report?.coverage?.total).toBe(1);
        });

        test("throws on a Reporter failure, authoring no report and no issues", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);

            await expect(
                runReporter({ snapshotId: run.snapshotId }, { produceResult: failingResult() }),
            ).rejects.toThrow();

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report).toBeNull();
            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(0);
        });

        test("writes the Impact Analysis reasoning onto the report", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);

            await runReporter(
                { snapshotId: run.snapshotId, impactReasoning: "The diff touches checkout." },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report",
                        reportEvidenceManifest: [],
                        summary: "One bug: the app misbehaves.",
                        issues: [{ kind: "open", content: issueContent("Checkout broken", ["checkout"]) }],
                    }),
                },
            );

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.impactReasoning).toBe("The diff touches checkout.");
        });
    },
});
