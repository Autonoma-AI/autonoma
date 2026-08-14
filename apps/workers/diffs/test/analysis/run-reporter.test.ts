import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import type { ReporterIssueContent, ReporterIssueResult, ReporterResult } from "@autonoma/diffs/analysis";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import type { ReporterPersisted, RunReporterOutput } from "@autonoma/workflow/activities";
import { expect } from "vitest";
import { runReporter } from "../../src/activities/analysis/run-reporter";
import { seedAnalysisIssue, seedGenerationForSlug } from "./seed-generation";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

let seq = 0;
const next = () => seq++;

/** A Reporter that returns a fixed result; the default clone+model path is bypassed. */
const fixedResult = (result: ReporterResult) => async () => result;
/** A Reporter that fails, exercising the failure path (which fails the run). */
const failingResult = () => async () => {
    throw new Error("reporter blew up");
};

/** Narrow to the persisted arm - the discarded arm is a test failure wherever this is used. */
function expectPersisted(result: RunReporterOutput): ReporterPersisted {
    if (!result.persisted) throw new Error(`expected a persisted reporter output, got: ${result.reason}`);
    return result;
}

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
    applicationId: string;
}

class ReporterHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<ReporterHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new ReporterHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
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
        for (const finding of findings) {
            const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
                applicationId: app.id,
                organizationId: org.id,
                snapshotId: snapshot.id,
                slug: finding.slug,
            });
            const created = await this.db.analysisFinding.create({
                data: { reportSnapshotId: snapshot.id, organizationId: org.id, testCaseId },
            });
            const classification = await this.db.analysisClassification.create({
                data: {
                    findingId: created.id,
                    number: 1,
                    organizationId: org.id,
                    generationId,
                    category: finding.category,
                    headline: `${finding.slug} headline`,
                },
            });
            await this.db.analysisFinding.update({
                where: { id: created.id },
                data: { currentClassificationId: classification.id },
            });
        }
        return {
            snapshotId: snapshot.id,
            organizationId: org.id,
            branchId: branch.id,
            applicationId: app.id,
        };
    }

    /**
     * An issue the branch already carries, covering the given tests. Its covered set is derived from the findings
     * attributed to it, so this seeds those findings on an EARLIER snapshot of the same branch - which is what an
     * issue carried across snapshots actually looks like.
     */
    async seedOpenIssue(run: SeededRun, coveredSlugs: string[]): Promise<string> {
        const issueId = await seedAnalysisIssue(this.db, {
            branchId: run.branchId,
            organizationId: run.organizationId,
            title: "Existing bug",
            narrativeMarkdown: "existing narrative",
        });

        const prior = await this.db.branchSnapshot.create({
            data: { branchId: run.branchId, source: "GITHUB_PUSH" },
        });
        await this.db.analysisJob.create({
            data: {
                snapshotId: prior.id,
                organizationId: run.organizationId,
                status: "completed",
                startedAt: new Date(),
            },
        });
        for (const slug of coveredSlugs) {
            const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
                applicationId: run.applicationId,
                organizationId: run.organizationId,
                snapshotId: prior.id,
                slug,
            });
            const finding = await this.db.analysisFinding.create({
                data: {
                    reportSnapshotId: prior.id,
                    organizationId: run.organizationId,
                    testCaseId,
                    issueId,
                },
            });
            const classification = await this.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId: run.organizationId,
                    generationId,
                    category: "client_bug",
                    headline: `${slug} headline`,
                },
            });
            await this.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });
        }
        return issueId;
    }

    /** The tests an issue currently covers, as the Reporter derives them: the findings attributed to it. */
    async coveredSlugs(issueId: string): Promise<Set<string>> {
        const findings = await this.db.analysisFinding.findMany({
            where: { issueId },
            select: { testCase: { select: { slug: true } } },
        });
        return new Set(findings.map((finding) => finding.testCase.slug));
    }

    /** This run's finding for a test, by slug. */
    async findingFor(run: SeededRun, slug: string) {
        return await this.db.analysisFinding.findFirstOrThrow({
            where: { reportSnapshotId: run.snapshotId, testCase: { slug } },
        });
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
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [openAction],
                    }),
                },
            );

            expect(result).toEqual({
                persisted: true,
                issuesOpened: 1,
                issuesCarried: 0,
                issuesResolved: 0,
                verdict: "client_bug",
                clientBugCount: 1,
            });

            const issues = await harness.db.analysisIssue.findMany({
                where: { branchId: run.branchId },
                include: { currentVersion: true },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0]?.currentVersion?.kind).toBe("bug");
            expect(issues[0]?.status).toBe("open");
            const issueId = issues[0]?.id ?? "";
            expect(await harness.coveredSlugs(issueId)).toEqual(new Set(["checkout"]));

            const finding = await harness.findingFor(run, "checkout");
            expect(finding.issueId).toBe(issueId);

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
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
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

            expect(expectPersisted(result).issuesResolved).toBe(1);
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
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [carry],
                    }),
                },
            );

            expect(expectPersisted(result).issuesCarried).toBe(1);
            const issue = await harness.db.analysisIssue.findUnique({ where: { id: existingId } });
            expect(issue?.status).toBe("open");
            expect(issue?.resolvedAt).toBeNull();
            // The covered set unions itself: this run's `checkout` finding joins the `profile` one an earlier
            // snapshot attributed, with no stored list to keep in sync.
            expect(await harness.coveredSlugs(existingId)).toEqual(new Set(["profile", "checkout"]));

            const finding = await harness.findingFor(run, "checkout");
            expect(finding.issueId).toBe(existingId);

            // The reopened bug keeps the report red.
            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.verdict).toBe("client_bug");
            expect(report?.clientBugCount).toBe(1);
        });

        test("carry-forward appends a version instead of overwriting the prior narrative in place", async ({
            harness,
        }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);
            const existingId = await harness.seedOpenIssue(run, ["checkout"]);

            await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nStill broken.",
                        reportEvidenceManifest: [],
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [
                            {
                                kind: "carry_forward",
                                existingIssueId: existingId,
                                content: issueContent("Checkout broken", ["checkout"]),
                            },
                        ],
                    }),
                },
            );

            const issue = await harness.db.analysisIssue.findUniqueOrThrow({
                where: { id: existingId },
                include: { versions: { orderBy: { createdAt: "asc" } }, currentVersion: true },
            });
            // The seed restatement survives; the carry-forward is a NEW row, not an overwrite of it.
            expect(issue.versions).toHaveLength(2);
            expect(issue.versions.map((version) => version.title)).toEqual(["Existing bug", "Checkout broken"]);
            // The seed had no origin run; the carried restatement records the snapshot that authored it.
            expect(issue.versions[0]?.snapshotId).toBeNull();
            expect(issue.versions[1]?.snapshotId).toBe(run.snapshotId);
            // Readers stand behind the newest restatement.
            expect(issue.currentVersion?.title).toBe("Checkout broken");
            expect(issue.currentVersionId).toBe(issue.versions[1]?.id);

            // A second settlement of the same snapshot is refused by the report-exists guard, so it re-authors
            // nothing: the restatement stays exactly one per (issue, snapshot) - never a twin, and never overwritten
            // by a later run of the same commit.
            const retry = await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report\nStill broken.",
                        reportEvidenceManifest: [],
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [
                            {
                                kind: "carry_forward",
                                existingIssueId: existingId,
                                content: issueContent("Checkout broken again", ["checkout"]),
                            },
                        ],
                    }),
                },
            );
            if (retry.persisted) throw new Error("expected the second settlement to be discarded, not persisted");
            expect(retry.reason).toBe("already_settled");
            const afterRetry = await harness.db.analysisIssueVersion.findMany({
                where: { issueId: existingId },
                orderBy: { createdAt: "asc" },
            });
            expect(afterRetry).toHaveLength(2);
            expect(afterRetry[1]?.title).toBe("Checkout broken");
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
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
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
                        title: "Autonoma checked this PR",
                        headline: "One bug: the app misbehaves.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [{ kind: "open", content: issueContent("Checkout broken", ["checkout"]) }],
                    }),
                },
            );

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.impactReasoning).toBe("The diff touches checkout.");
        });

        // The empty run the `no_tests_needed` verdict rests on: nothing queued means nothing to lose, so the guard
        // must let the report through. Weaken this and an empty run stops being a decision.
        test("writes a report when the run queued nothing at all", async ({ harness }) => {
            const run = await harness.seedRun([]);

            const result = await runReporter(
                { snapshotId: run.snapshotId, impactReasoning: "Documentation only." },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report",
                        reportEvidenceManifest: [],
                        title: "Autonoma checked this PR",
                        headline: "Nothing here needed testing.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [],
                    }),
                },
            );

            expect(expectPersisted(result).verdict).toBe("passed");
            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report?.testCount).toBe(0);
        });

        // Containment is persisted per target and swallowed on failure, so a run can lose ONE verdict and still have
        // others - the guard has to compare counts, not just catch the all-or-nothing case.
        test("refuses to write a report when one of several queued tests produced no verdict", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "passed" }]);
            await seedGenerationForSlug(harness.db, {
                applicationId: run.applicationId,
                organizationId: run.organizationId,
                snapshotId: run.snapshotId,
                slug: "search",
            });

            await expect(
                runReporter(
                    { snapshotId: run.snapshotId },
                    {
                        produceResult: fixedResult({
                            reportMarkdown: "## Report",
                            reportEvidenceManifest: [],
                            title: "Autonoma checked this PR",
                            headline: "Everything held up.",
                            flows: [],
                            flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                            issues: [],
                        }),
                    },
                ),
            ).rejects.toThrow(/queued 2 test\(s\) but only 1/);

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report).toBeNull();
        });

        // The exit guard: a Reporter that finishes after a newer push superseded its run must not mutate
        // branch-scoped issues on evidence from a head the PR no longer contains. The producer settles the
        // snapshot WHILE the Reporter works - after its findings landed, before its persist - which is the race
        // the in-transaction liveness assertion closes.
        test("a Reporter whose snapshot is settled while it works discards its result", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "login", category: "passed" }]);
            const existingId = await harness.seedOpenIssue(run, ["login"]);

            const result = await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: async () => {
                        await harness.db.branchSnapshot.update({
                            where: { id: run.snapshotId },
                            data: { status: "cancelled" },
                        });
                        return {
                            reportMarkdown: "## Report\nStale evidence.",
                            reportEvidenceManifest: [],
                            title: "The run",
                            headline: "Stale.",
                            flows: [],
                            flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                            issues: [
                                {
                                    kind: "resolve",
                                    existingIssueId: existingId,
                                    resolvingFindingSlug: "login",
                                    note: "passes on a head the branch has left",
                                },
                                { kind: "open", content: issueContent("Stale bug", ["login"]) },
                            ],
                        };
                    },
                },
            );

            expect(result).toEqual({ persisted: false, reason: "superseded" });
            expect(await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } })).toBeNull();
            const existing = await harness.db.analysisIssue.findUniqueOrThrow({ where: { id: existingId } });
            expect(existing.status).toBe("open");
            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(1);
            const finding = await harness.findingFor(run, "login");
            expect(finding.issueId).toBeNull();
        });

        // Re-invoking the Reporter on one analysis must not duplicate every opened issue: the settlement is born
        // exactly once, and a second invocation reports the discard instead of re-applying its reconciliations.
        test("re-invoking the Reporter does not duplicate its issues", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "checkout", category: "client_bug" }]);
            const produceResult = fixedResult({
                reportMarkdown: "## Report",
                reportEvidenceManifest: [],
                title: "The run",
                headline: "One bug.",
                flows: [],
                flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                issues: [{ kind: "open", content: issueContent("Checkout broken", ["checkout"]) }],
            });

            const first = await runReporter({ snapshotId: run.snapshotId }, { produceResult });
            const second = await runReporter({ snapshotId: run.snapshotId }, { produceResult });

            expect(first.persisted).toBe(true);
            expect(second).toEqual({ persisted: false, reason: "already_settled" });
            expect(await harness.db.analysisIssue.count({ where: { branchId: run.branchId } })).toBe(1);
        });

        // A resolve's justification survives to the row: which passing finding closed the issue, and why.
        test("a resolve records the resolving finding and the Reporter's note", async ({ harness }) => {
            const run = await harness.seedRun([{ slug: "login", category: "passed" }]);
            const existingId = await harness.seedOpenIssue(run, ["login"]);

            await runReporter(
                { snapshotId: run.snapshotId },
                {
                    produceResult: fixedResult({
                        reportMarkdown: "## Report",
                        reportEvidenceManifest: [],
                        title: "The run",
                        headline: "Fixed.",
                        flows: [],
                        flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                        issues: [
                            {
                                kind: "resolve",
                                existingIssueId: existingId,
                                resolvingFindingSlug: "login",
                                note: "The covering login test passed on this head.",
                            },
                        ],
                    }),
                },
            );

            const issue = await harness.db.analysisIssue.findUniqueOrThrow({ where: { id: existingId } });
            const resolving = await harness.findingFor(run, "login");
            expect(issue.resolvedByFindingId).toBe(resolving.id);
            expect(issue.resolutionNote).toBe("The covering login test passed on this head.");
        });

        test("refuses to write a report when a queued test produced no verdict", async ({ harness }) => {
            const run = await harness.seedRun([]);
            await seedGenerationForSlug(harness.db, {
                applicationId: run.applicationId,
                organizationId: run.organizationId,
                snapshotId: run.snapshotId,
                slug: "checkout",
            });

            await expect(
                runReporter(
                    { snapshotId: run.snapshotId },
                    {
                        produceResult: fixedResult({
                            reportMarkdown: "## Report",
                            reportEvidenceManifest: [],
                            title: "Autonoma checked this PR",
                            headline: "Nothing ran.",
                            flows: [],
                            flowCorrections: { sweptSlugs: [], duplicateSlugs: [], unknownSlugs: [] },
                            issues: [],
                        }),
                    },
                ),
            ).rejects.toThrow(/queued 1 test/);

            const report = await harness.db.analysisReport.findUnique({ where: { snapshotId: run.snapshotId } });
            expect(report).toBeNull();
        });
    },
});
