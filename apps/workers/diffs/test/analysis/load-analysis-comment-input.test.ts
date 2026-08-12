import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { loadAnalysisCommentInput } from "../../src/activities/analysis/load-analysis-comment-input";
import { seedGenerationForSlug } from "./seed-generation";

/** When a seeded issue was resolved. Written with `status`, which is how the store reads the two as one fact. */
const RESOLVED_AT = new Date("2026-07-01T00:00:00Z");

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

let seq = 0;
const next = () => seq++;

const OLDER_RUN_AT = new Date("2026-07-01T10:00:00Z");
const NEWER_RUN_AT = new Date("2026-07-02T10:00:00Z");

interface SeededBranch {
    branchId: string;
    organizationId: string;
    applicationId: string;
    /** The snapshot the comment is being built for (the newest run). */
    snapshotId: string;
    olderSnapshotId: string;
}

interface SeedIssueOptions {
    primaryFindingSlug?: string;
    severity?: string;
    withSuspectedCause?: boolean;
    withPrimaryScreenshot?: boolean;
    status?: string;
}

class CommentInputHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<CommentInputHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new CommentInputHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /**
     * A branch with TWO completed runs of the same test, so "which run does the card feature" is a real question:
     * both snapshots carry a `checkout` finding with its own clip, one day apart.
     */
    async seedBranch(headline = "Checkout is broken on this PR."): Promise<SeededBranch> {
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

        const older = await this.seedRun(branch.id, org.id, app.id, OLDER_RUN_AT, "old");
        const newer = await this.seedRun(branch.id, org.id, app.id, NEWER_RUN_AT, "new");

        await this.db.analysisReport.create({
            data: {
                snapshotId: newer,
                organizationId: org.id,
                verdict: "client_bug",
                headline,
                title: "Checkout broken on this PR",
                reportMarkdown: "## Report\nCheckout is broken.",
                clientBugCount: 1,
                testCount: 2,
            },
        });

        return {
            branchId: branch.id,
            organizationId: org.id,
            applicationId: app.id,
            snapshotId: newer,
            olderSnapshotId: older,
        };
    }

    /** One run: a snapshot at `runAt`, its job, and a `checkout` + `cart` finding whose clips name the run. */
    private async seedRun(
        branchId: string,
        organizationId: string,
        applicationId: string,
        runAt: Date,
        tag: string,
    ): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "GITHUB_PUSH", createdAt: runAt },
        });
        await this.db.analysisJob.create({
            data: {
                snapshotId: snapshot.id,
                organizationId,
                status: "completed",
                startedAt: runAt,
                completedAt: runAt,
            },
        });
        for (const slug of ["checkout", "cart"]) {
            const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
                applicationId,
                organizationId,
                snapshotId: snapshot.id,
                slug,
            });
            const finding = await this.db.analysisFinding.create({
                data: { reportSnapshotId: snapshot.id, organizationId, testCaseId },
            });
            const classification = await this.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId,
                    generationId,
                    category: "client_bug",
                    headline: `${slug} headline`,
                    clipKey: `s3://bucket/${tag}-${slug}.gif`,
                },
            });
            await this.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });
        }
        return snapshot.id;
    }

    /**
     * One coverage-plane finding on the newest run, optionally attributed to a branch issue of `issueKind` - which is
     * how the Reporter places an `environment_failure` on the reader's side rather than ours.
     */
    async seedCoverageFinding(
        branch: SeededBranch,
        options: {
            slug: string;
            category: string;
            issueKind?: string;
            issueTitle?: string;
            issueStatus?: string;
            issueSeverity?: string;
        },
    ): Promise<void> {
        const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
            applicationId: branch.applicationId,
            organizationId: branch.organizationId,
            snapshotId: branch.snapshotId,
            slug: options.slug,
        });
        const issueId =
            options.issueKind == null
                ? undefined
                : (
                      await this.db.analysisIssue.create({
                          data: {
                              branchId: branch.branchId,
                              organizationId: branch.organizationId,
                              title: options.issueTitle ?? `${options.slug} issue`,
                              kind: options.issueKind,
                              severity: options.issueSeverity ?? "high",
                              status: options.issueStatus ?? "open",
                              resolvedAt: options.issueStatus === "resolved" ? RESOLVED_AT : null,
                              actualBehavior: "The flow never ran.",
                              narrativeMarkdown: "narrative",
                          },
                      })
                  ).id;
        const finding = await this.db.analysisFinding.create({
            data: { reportSnapshotId: branch.snapshotId, organizationId: branch.organizationId, testCaseId, issueId },
        });
        const classification = await this.db.analysisClassification.create({
            data: {
                findingId: finding.id,
                number: 1,
                organizationId: branch.organizationId,
                generationId,
                category: options.category,
                headline: `${options.slug} headline`,
            },
        });
        await this.db.analysisFinding.update({
            where: { id: finding.id },
            data: { currentClassificationId: classification.id },
        });
    }

    /** An open bug issue covering both runs' `checkout` findings (and this branch's `cart` findings). */
    async seedIssue(branch: SeededBranch, options: SeedIssueOptions = {}): Promise<string> {
        const issue = await this.db.analysisIssue.create({
            data: {
                branch: { connect: { id: branch.branchId } },
                organization: { connect: { id: branch.organizationId } },
                title: "Place order never enables",
                kind: "bug",
                severity: options.severity ?? "critical",
                status: options.status ?? "open",
                resolvedAt: options.status === "resolved" ? RESOLVED_AT : null,
                actualBehavior: "The button stayed disabled.",
                narrativeMarkdown: "narrative",
                primaryTestCase: {
                    connect: {
                        applicationId_slug: {
                            applicationId: branch.applicationId,
                            slug: options.primaryFindingSlug ?? "checkout",
                        },
                    },
                },
                primaryScreenshot:
                    options.withPrimaryScreenshot === false ? undefined : { s3Key: "s3://bucket/hero.png" },
                suspectedCause:
                    options.withSuspectedCause === false
                        ? undefined
                        : {
                              explanation: "formValid is computed once on mount.",
                              codeReferences: [{ file: "src/PlaceOrder.tsx", lines: "42-58" }],
                          },
            },
        });
        // Attribute BOTH runs' checkout findings to the issue - the cross-snapshot recurrence the card picks from.
        await this.db.analysisFinding.updateMany({
            where: {
                testCase: { slug: "checkout" },
                reportSnapshotId: { in: [branch.snapshotId, branch.olderSnapshotId] },
            },
            data: { issueId: issue.id },
        });
        return issue.id;
    }
}

integrationTestSuite({
    name: "loadAnalysisCommentInput (issue -> designated reproduction)",
    createHarness: () => CommentInputHarness.create(),
    cases: (test) => {
        test("features the NEWEST run of the designated test, not the first attributed finding", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            const issueId = await harness.seedIssue(branch);

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            expect(loaded?.bugIssues).toHaveLength(1);
            const card = loaded?.bugIssues[0];
            expect(card?.id).toBe(issueId);
            // The newer snapshot's clip, even though the older finding was created first.
            expect(card?.clipKey).toBe("s3://bucket/new-checkout.gif");
            const newest = await harness.db.analysisFinding.findFirstOrThrow({
                where: { reportSnapshotId: branch.snapshotId, testCase: { slug: "checkout" } },
            });
            expect(card?.replay).toEqual({ snapshotId: branch.snapshotId, findingId: newest.id });
            expect(card?.screenshotKey).toBe("s3://bucket/hero.png");
            expect(card?.suspectedCause?.explanation).toBe("formValid is computed once on mount.");
        });

        test("degrades to the hero frame with no replay when the designated slug has no attributed finding", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            // `cart` findings exist on the branch but were never attributed to this issue.
            await harness.seedIssue(branch, { primaryFindingSlug: "cart" });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            const card = loaded?.bugIssues[0];
            expect(card?.clipKey).toBeUndefined();
            expect(card?.replay).toBeUndefined();
            expect(card?.screenshotKey).toBe("s3://bucket/hero.png");
        });

        test("passes the Reporter's prose straight through, translating nothing", async ({ harness }) => {
            // This path only ever reads a row the current run just wrote, and `finish` refuses prose that sanitizing
            // emptied - so there is no empty case to translate, and the read boundary carries no guard for one.
            const branch = await harness.seedBranch("Checkout is broken on this PR.");

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            expect(loaded?.headline).toBe("Checkout is broken on this PR.");
            expect(loaded?.title).toBe("Checkout broken on this PR");
        });

        // The row still counts toward the verdict, so dropping its card would have the comment block on a bug it
        // never names. The ledger degrades the severity to `low` instead - listed, sorted last.
        test("cards an issue whose severity cannot be parsed, sorted as low", async ({ harness }) => {
            const branch = await harness.seedBranch();
            const issueId = await harness.seedIssue(branch, { severity: "catastrophic" });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            expect(loaded?.bugIssues.map((issue) => issue.id)).toEqual([issueId]);
        });

        test("cards only OPEN bug issues, so a resolved one leaves the comment", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.seedIssue(branch, { status: "resolved" });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            expect(loaded?.bugIssues).toEqual([]);
        });

        test("places an env gap on the reader's side only when the Reporter filed an issue for it", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            // Their configuration: the Reporter opened an environment issue naming what to fix.
            await harness.seedCoverageFinding(branch, {
                slug: "invoices",
                category: "environment_failure",
                issueKind: "environment",
                issueTitle: "Preview is missing the Firestore index invoices need",
            });
            // Ours: a preview that never came up, so no issue was filed and nothing is asked of them.
            await harness.seedCoverageFinding(branch, { slug: "reports", category: "environment_failure" });
            // Theirs by taxonomy, and the Reporter's scenario issue says what to seed.
            await harness.seedCoverageFinding(branch, {
                slug: "coupons",
                category: "scenario_issue",
                issueKind: "scenario",
                issueTitle: "Checkout scenario seeds no coupon codes",
            });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            // Same severity, so they hold the query's slug order: `coupons` before `invoices`.
            expect(loaded?.coverageIssues.map((issue) => issue.title)).toEqual([
                "Checkout scenario seeds no coupon codes",
                "Preview is missing the Firestore index invoices need",
            ]);
        });

        test("keeps an env gap on the reader's side when its issue's severity is malformed", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.seedCoverageFinding(branch, {
                slug: "invoices",
                category: "environment_failure",
                issueKind: "environment",
                issueTitle: "Preview is missing the Firestore index invoices need",
                issueSeverity: "catastrophic",
            });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            // Severity only decides where the issue sorts; dropping the row would silently move the gap to our side.
            expect(loaded?.coverageIssues.map((issue) => issue.title)).toEqual([
                "Preview is missing the Firestore index invoices need",
            ]);
        });

        test("ignores a resolved coverage issue, so a fixed gap stops being asked of the reader", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            await harness.seedCoverageFinding(branch, {
                slug: "invoices",
                category: "environment_failure",
                issueKind: "environment",
                issueStatus: "resolved",
            });

            const loaded = await loadAnalysisCommentInput(branch.snapshotId);

            expect(loaded?.coverageIssues).toEqual([]);
        });

        test("returns undefined for a snapshot with no report", async ({ harness }) => {
            const branch = await harness.seedBranch();

            const loaded = await loadAnalysisCommentInput(branch.olderSnapshotId);

            expect(loaded).toBeUndefined();
        });
    },
});
