import type { Prisma, PrismaClient } from "@autonoma/db";

let seq = 0;

/** The fixed instant a seeded resolved issue is closed at, when the caller does not pin one. */
const SEED_RESOLVED_AT = new Date("2026-01-01T00:00:00.000Z");

/** The authored content + lifecycle a seeded AnalysisIssue needs. Content lands on the issue's one seed version. */
export interface SeedAnalysisIssueInput {
    branchId: string;
    organizationId: string;
    /** Resolve the issue - the store reads `resolvedAt`'s presence, never a status. Closed at `resolvedAt` when
     * given, else at a fixed default instant. */
    resolved?: boolean;
    resolvedAt?: Date;
    title?: string;
    kind?: string;
    severity?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    narrativeMarkdown?: string;
    primaryTestCaseId?: string;
    evidenceManifest?: Prisma.AnalysisIssueVersionCreateInput["evidenceManifest"];
    primaryScreenshot?: Prisma.AnalysisIssueVersionCreateInput["primaryScreenshot"];
    suspectedCause?: Prisma.AnalysisIssueVersionCreateInput["suspectedCause"];
    /** Findings to attribute to the issue, created nested (they FK the issue, not its version). */
    findings?: Prisma.AnalysisFindingCreateWithoutIssueInput[];
}

/**
 * Seed an AnalysisIssue the way the Reporter writes one: an issue row carrying identity + lifecycle, one immutable
 * version carrying the authored content, and the `currentVersion` pointer aimed at it. Returns the issue id.
 */
export async function seedAnalysisIssue(db: PrismaClient, input: SeedAnalysisIssueInput): Promise<string> {
    const resolvedAt = input.resolvedAt ?? (input.resolved === true ? SEED_RESOLVED_AT : undefined);
    const issue = await db.analysisIssue.create({
        data: {
            branchId: input.branchId,
            organizationId: input.organizationId,
            resolvedAt,
            findings: input.findings != null ? { create: input.findings } : undefined,
        },
    });
    const version = await db.analysisIssueVersion.create({
        data: {
            issueId: issue.id,
            organizationId: input.organizationId,
            title: input.title ?? "Seeded issue",
            kind: input.kind ?? "bug",
            severity: input.severity ?? "high",
            expectedBehavior: input.expectedBehavior ?? undefined,
            actualBehavior: input.actualBehavior ?? "misbehaves",
            narrativeMarkdown: input.narrativeMarkdown ?? "seeded narrative",
            primaryTestCaseId: input.primaryTestCaseId ?? undefined,
            evidenceManifest: input.evidenceManifest ?? undefined,
            primaryScreenshot: input.primaryScreenshot ?? undefined,
            suspectedCause: input.suspectedCause ?? undefined,
        },
    });
    await db.analysisIssue.update({ where: { id: issue.id }, data: { currentVersionId: version.id } });
    return issue.id;
}

/**
 * Seeds the test case / plan / generation chain one `AnalysisFinding` needs: the finding FKs the test case, and its
 * classification FKs the generation whose run it judged, so both ids are returned.
 *
 * The test case's slug matches the finding's, mirroring how the pipeline lines the two up, and is reused across
 * calls for the same application - a slug is unique per application, and a branch's successive runs re-investigate
 * the SAME test, each on its own generation.
 */
export async function seedGenerationForSlug(
    db: PrismaClient,
    params: { applicationId: string; organizationId: string; snapshotId: string; slug: string },
): Promise<{ testCaseId: string; generationId: string }> {
    const { organizationId, snapshotId, slug } = params;

    const testCaseId = await findOrCreateTestCase(db, params);
    const plan = await db.testPlan.create({
        data: { testCaseId, prompt: `${slug} plan ${seq++}`, organizationId },
    });
    const generation = await db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId, status: "success" },
        select: { id: true },
    });

    return { testCaseId, generationId: generation.id };
}

/** The test case a slug names in an application, minting it (with a flow to hold it) the first time. */
export async function findOrCreateTestCase(
    db: PrismaClient,
    { applicationId, organizationId, slug }: { applicationId: string; organizationId: string; slug: string },
): Promise<string> {
    const existing = await db.testCase.findUnique({
        where: { applicationId_slug: { applicationId, slug } },
        select: { id: true },
    });
    if (existing != null) return existing.id;

    const folder = await db.folder.create({
        data: { name: `Flow ${slug}`, applicationId, organizationId },
    });
    const created = await db.testCase.create({
        data: { name: slug, slug, applicationId, folderId: folder.id, organizationId },
        select: { id: true },
    });
    return created.id;
}
