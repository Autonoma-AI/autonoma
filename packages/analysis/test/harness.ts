import { type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { analysisVerdictSchema } from "@autonoma/types";
import type { TestAPI } from "vitest";
import { AnalysisStore } from "../src/analysis-store";
import type { IssueReconciliation, ReportSettlement } from "../src/settle-report";

export interface SeededAnalysis {
    organizationId: string;
    applicationId: string;
    branchId: string;
    snapshotId: string;
}

export class AnalysisHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly store: AnalysisStore;

    private counter = 0;

    constructor(db: PrismaClient) {
        this.db = db;
        this.store = new AnalysisStore(db);
    }

    static async create(): Promise<AnalysisHarness> {
        return new AnalysisHarness(createClient(await createTestDatabase()));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    next(): number {
        this.counter += 1;
        return this.counter;
    }

    /** A fresh org/app/branch with one open (`processing`) snapshot carrying a `running` AnalysisJob. */
    async seedAnalysis(): Promise<SeededAnalysis> {
        const n = this.next();
        const org = await this.db.organization.create({
            data: { name: `Org ${n}`, slug: `org-${n}-${Date.now()}` },
        });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}-${Date.now()}`, organizationId: org.id, architecture: "WEB" },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        const snapshotId = await this.addSnapshot(branch.id, org.id);
        return { organizationId: org.id, applicationId: app.id, branchId: branch.id, snapshotId };
    }

    /** Another open snapshot (with its job) on the same branch - a later run in the lineage. */
    async addSnapshot(branchId: string, organizationId: string): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "GITHUB_PUSH" },
            select: { id: true },
        });
        await this.store.open({ snapshotId: snapshot.id, organizationId });
        return snapshot.id;
    }

    /** The test case / plan / generation chain a classification points at; the slug names the test. */
    async seedRunForSlug(
        run: SeededAnalysis,
        slug: string,
        options?: { snapshotId?: string },
    ): Promise<{ testCaseId: string; generationId: string }> {
        const snapshotId = options?.snapshotId ?? run.snapshotId;
        const testCaseId = await this.findOrCreateTestCase(run, slug);
        const plan = await this.db.testPlan.create({
            data: { testCaseId, prompt: `${slug} plan ${this.next()}`, organizationId: run.organizationId },
        });
        const generation = await this.db.testGeneration.create({
            data: { testPlanId: plan.id, snapshotId, organizationId: run.organizationId, status: "success" },
            select: { id: true },
        });
        return { testCaseId, generationId: generation.id };
    }

    /** A test case with no run - a target whose Investigator may have crashed before starting one. */
    async findOrCreateTestCase(run: SeededAnalysis, slug: string): Promise<string> {
        const existing = await this.db.testCase.findUnique({
            where: { applicationId_slug: { applicationId: run.applicationId, slug } },
            select: { id: true },
        });
        if (existing != null) return existing.id;
        const folder = await this.db.folder.create({
            data: { name: `Flow ${slug}`, applicationId: run.applicationId, organizationId: run.organizationId },
        });
        const created = await this.db.testCase.create({
            data: {
                name: slug,
                slug,
                applicationId: run.applicationId,
                folderId: folder.id,
                organizationId: run.organizationId,
            },
            select: { id: true },
        });
        return created.id;
    }

    /** Record one unjudged finding per slug; returns each slug's test case id. */
    async selectTests(run: SeededAnalysis, slugs: string[]): Promise<Map<string, string>> {
        const testCaseIdBySlug = new Map<string, string>();
        for (const slug of slugs) {
            testCaseIdBySlug.set(slug, await this.findOrCreateTestCase(run, slug));
        }
        await this.store.forAnalysis(run.snapshotId).recordSelection(
            [...testCaseIdBySlug.values()].map((testCaseId) => ({
                testCaseId,
                origin: "pre_existing",
                selectionReason: `${testCaseId} affected by the diff`,
            })),
        );
        return testCaseIdBySlug;
    }

    /** Record one classified iteration for a slug, seeding its run chain. */
    async recordVerdict(
        run: SeededAnalysis,
        slug: string,
        category: string,
        options?: { number?: number; snapshotId?: string },
    ): Promise<{ testCaseId: string; generationId: string; findingId: string }> {
        const snapshotId = options?.snapshotId ?? run.snapshotId;
        const { testCaseId, generationId } = await this.seedRunForSlug(run, slug, { snapshotId });
        const scope = this.store.forAnalysis(snapshotId);
        const { findingId } = await scope.recordClassification({
            testCaseId,
            origin: "pre_existing",
            number: options?.number ?? 1,
            generationId,
            category: analysisVerdictSchema.parse(category),
            headline: `${slug} ${category}`,
        });
        return { testCaseId, generationId, findingId };
    }

    /** A minimal settlement whose reconciliations are the interesting part. */
    settlement(issues: IssueReconciliation[] = []): ReportSettlement {
        return {
            content: {
                title: "The run",
                headline: "summary",
                flows: [],
                reportMarkdown: "## Report",
                evidenceManifest: [],
            },
            issues,
        };
    }
}

type AnalysisSuiteContext = { harness: AnalysisHarness };

interface AnalysisSuiteParams {
    name: string;
    cases: (test: TestAPI<AnalysisSuiteContext>) => void;
}

/** Every test seeds its own org/branch/snapshot via `harness.seedAnalysis()` - nothing is shared between tests. */
export function analysisSuite({ name, cases }: AnalysisSuiteParams) {
    integrationTestSuite<AnalysisHarness, undefined>({
        name,
        createHarness: () => AnalysisHarness.create(),
        cases,
    });
}
