import type { Prisma, PrismaClient } from "@autonoma/db";

/**
 * One classification iteration in full - every verdict field, not the history summary. Media ride as raw
 * `s3://` keys; signing is the caller's boundary.
 */
export interface FindingDetailClassification {
    id: string;
    /** 1-based iteration of the Investigator's self-heal loop. */
    number: number;
    /** The generation this iteration ran and judged - the drawer's steps and recording come from it. */
    generationId: string;
    category: string;
    confidence?: string;
    headline: string;
    createdAt: Date;
    expectedBehavior?: string;
    actualBehavior?: string;
    whatHappened?: string;
    planMismatchNote?: string;
    invalidTestNote?: string;
    observedAppIssues?: string;
    remediation?: string;
    rootCause?: string;
    falsePositiveRisk?: string;
    evidence?: PrismaJson.InvestigationEvidenceList;
    screenshotKey?: string;
    conversationUrl?: string;
    error?: string;
}

/** One finding with its full classification history, as the per-finding detail read consumes it. */
export interface FindingDetailRecord {
    findingId: string;
    snapshotId: string;
    testCase: { id: string; name: string; slug: string; description?: string };
    origin?: string;
    selectionReason?: string;
    failure?: PrismaJson.AnalysisFindingFailure;
    /** Absent between creation and first classification, or permanently on a contained investigation. */
    currentClassificationId?: string;
    /** Oldest first, the current one included. */
    classifications: FindingDetailClassification[];
}

/** One finding by id, org-scoped in the where. Undefined for an unknown or foreign finding. */
export async function readFindingDetail(
    db: PrismaClient | Prisma.TransactionClient,
    input: { findingId: string; organizationId: string },
): Promise<FindingDetailRecord | undefined> {
    const row = await db.analysisFinding.findUnique({
        where: { id: input.findingId, organizationId: input.organizationId },
        select: detailSelect,
    });
    if (row == null) return undefined;

    return {
        findingId: row.id,
        snapshotId: row.reportSnapshotId,
        testCase: {
            id: row.testCase.id,
            name: row.testCase.name,
            slug: row.testCase.slug,
            description: row.testCase.description ?? undefined,
        },
        origin: row.origin ?? undefined,
        selectionReason: row.selectionReason ?? undefined,
        failure: row.failure ?? undefined,
        currentClassificationId: row.currentClassificationId ?? undefined,
        classifications: row.classifications.map(toClassification),
    };
}

const detailSelect = {
    id: true,
    reportSnapshotId: true,
    origin: true,
    selectionReason: true,
    failure: true,
    currentClassificationId: true,
    testCase: { select: { id: true, name: true, slug: true, description: true } },
    classifications: {
        orderBy: { number: "asc" },
        select: {
            id: true,
            number: true,
            generationId: true,
            category: true,
            confidence: true,
            headline: true,
            createdAt: true,
            expectedBehavior: true,
            actualBehavior: true,
            whatHappened: true,
            planMismatchNote: true,
            invalidTestNote: true,
            observedAppIssues: true,
            remediation: true,
            rootCause: true,
            falsePositiveRisk: true,
            evidence: true,
            screenshotKey: true,
            conversationUrl: true,
            error: true,
        },
    },
} satisfies Prisma.AnalysisFindingSelect;

type DetailRow = Prisma.AnalysisFindingGetPayload<{ select: typeof detailSelect }>;

function toClassification(row: DetailRow["classifications"][number]): FindingDetailClassification {
    return {
        id: row.id,
        number: row.number,
        generationId: row.generationId,
        category: row.category,
        confidence: row.confidence ?? undefined,
        headline: row.headline,
        createdAt: row.createdAt,
        expectedBehavior: row.expectedBehavior ?? undefined,
        actualBehavior: row.actualBehavior ?? undefined,
        whatHappened: row.whatHappened ?? undefined,
        planMismatchNote: row.planMismatchNote ?? undefined,
        invalidTestNote: row.invalidTestNote ?? undefined,
        observedAppIssues: row.observedAppIssues ?? undefined,
        remediation: row.remediation ?? undefined,
        rootCause: row.rootCause ?? undefined,
        falsePositiveRisk: row.falsePositiveRisk ?? undefined,
        evidence: row.evidence ?? undefined,
        screenshotKey: row.screenshotKey ?? undefined,
        conversationUrl: row.conversationUrl ?? undefined,
        error: row.error ?? undefined,
    };
}
