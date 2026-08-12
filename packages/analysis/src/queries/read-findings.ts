import type { Prisma, PrismaClient } from "@autonoma/db";
import type { AnalysisIssueStatus } from "@autonoma/types";
import { type IssueEnums, parseIssueEnums } from "../issue-enums";
import { issueStatusOf } from "./read-issues";

/** A finding's current classification. Media ride as raw `s3://` keys; signing is the caller's boundary. */
export interface FindingClassification {
    generationId: string;
    category: string;
    confidence?: string;
    headline: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    whatHappened?: string;
    planMismatchNote?: string;
    invalidTestNote?: string;
    observedAppIssues?: string;
    remediation?: string;
    rootCause?: string;
    falsePositiveRisk?: string;
    plan?: string;
    runSuccess?: boolean;
    stepCount?: number;
    runSteps?: PrismaJson.InvestigationRunSteps;
    runTrace?: PrismaJson.InvestigationRunTrace;
    evidence?: PrismaJson.InvestigationEvidenceList;
    videoKey?: string;
    optimizedVideoKey?: string;
    screenshotKey?: string;
    error?: string;
}

export interface ClassificationHistoryEntry {
    id: string;
    number: number;
    generationId: string;
    category: string;
    headline: string;
    createdAt: Date;
    /** Raw `s3://` key; signed by the caller. */
    conversationUrl?: string;
}

/** The branch issue a finding was attributed to, with its enums validated. */
export interface AttributedIssue extends IssueEnums {
    id: string;
    title: string;
    status: AnalysisIssueStatus;
}

/** One test's investigation within one analysis, as recorded so far. Ordered by slug on read. */
export interface Finding {
    findingId: string;
    testCase: { id: string; name: string; slug: string };
    origin?: string;
    selectionReason?: string;
    failure?: PrismaJson.AnalysisFindingFailure;
    selfHealed: boolean;
    /** The verdict this run stands behind. Absent on a contained investigation that never judged a run. */
    current?: FindingClassification;
    /** Oldest first, the current one included. */
    classifications: ClassificationHistoryEntry[];
    /**
     * Absent when unattributed, and when the issue row's kind/status are unreadable - which reads the same as
     * unattributed on purpose, so a corrupt attribution cannot change who owns a coverage gap.
     */
    issue?: AttributedIssue;
}

/**
 * One analysis's findings, contained ones included, slug-ordered so a prompt built over them does not depend on
 * the order Postgres returned the rows in. Only the current classification is the verdict; a superseded
 * self-heal iteration stays reachable through `classifications`.
 */
export async function readFindings(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<Finding[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId },
        orderBy: { testCase: { slug: "asc" } },
        select: findingSelect,
    });
    return rows.map(toFinding);
}

export interface FindingIdentity {
    findingId: string;
    testCaseId: string;
    slug: string;
}

/** The identities of the findings whose current verdict is one of `categories`, slug-ordered. */
export async function readFindingIds(
    db: PrismaClient | Prisma.TransactionClient,
    input: { snapshotId: string; organizationId?: string; categories: readonly string[] },
): Promise<FindingIdentity[]> {
    const rows = await db.analysisFinding.findMany({
        where: {
            reportSnapshotId: input.snapshotId,
            organizationId: input.organizationId,
            currentClassification: { category: { in: [...input.categories] } },
        },
        orderBy: { testCase: { slug: "asc" } },
        select: { id: true, testCaseId: true, testCase: { select: { slug: true } } },
    });
    return rows.map((row) => ({ findingId: row.id, testCaseId: row.testCaseId, slug: row.testCase.slug }));
}

const findingSelect = {
    id: true,
    origin: true,
    selectionReason: true,
    failure: true,
    testCase: { select: { id: true, name: true, slug: true } },
    issue: { select: { id: true, title: true, kind: true, severity: true, resolvedAt: true } },
    currentClassification: {
        select: {
            generationId: true,
            category: true,
            confidence: true,
            headline: true,
            expectedBehavior: true,
            actualBehavior: true,
            whatHappened: true,
            planMismatchNote: true,
            invalidTestNote: true,
            observedAppIssues: true,
            remediation: true,
            rootCause: true,
            falsePositiveRisk: true,
            plan: true,
            runSuccess: true,
            stepCount: true,
            runSteps: true,
            runTrace: true,
            evidence: true,
            videoKey: true,
            optimizedVideoKey: true,
            screenshotKey: true,
            error: true,
        },
    },
    classifications: {
        orderBy: { number: "asc" },
        select: {
            id: true,
            number: true,
            generationId: true,
            category: true,
            headline: true,
            createdAt: true,
            conversationUrl: true,
        },
    },
} satisfies Prisma.AnalysisFindingSelect;

type FindingRow = Prisma.AnalysisFindingGetPayload<{ select: typeof findingSelect }>;

function toFinding(row: FindingRow): Finding {
    const current = row.currentClassification;
    const issueEnums = row.issue == null ? undefined : parseIssueEnums(row.issue);
    return {
        findingId: row.id,
        testCase: row.testCase,
        origin: row.origin ?? undefined,
        selectionReason: row.selectionReason ?? undefined,
        failure: row.failure ?? undefined,
        selfHealed: row.classifications.length > 1,
        issue:
            row.issue == null || issueEnums == null
                ? undefined
                : {
                      id: row.issue.id,
                      title: row.issue.title,
                      kind: issueEnums.kind,
                      severity: issueEnums.severity,
                      status: issueStatusOf(row.issue.resolvedAt),
                  },
        classifications: row.classifications.map((classification) => ({
            id: classification.id,
            number: classification.number,
            generationId: classification.generationId,
            category: classification.category,
            headline: classification.headline,
            createdAt: classification.createdAt,
            conversationUrl: classification.conversationUrl ?? undefined,
        })),
        current:
            current == null
                ? undefined
                : {
                      generationId: current.generationId,
                      category: current.category,
                      confidence: current.confidence ?? undefined,
                      headline: current.headline,
                      expectedBehavior: current.expectedBehavior ?? undefined,
                      actualBehavior: current.actualBehavior ?? undefined,
                      whatHappened: current.whatHappened ?? undefined,
                      planMismatchNote: current.planMismatchNote ?? undefined,
                      invalidTestNote: current.invalidTestNote ?? undefined,
                      observedAppIssues: current.observedAppIssues ?? undefined,
                      remediation: current.remediation ?? undefined,
                      rootCause: current.rootCause ?? undefined,
                      falsePositiveRisk: current.falsePositiveRisk ?? undefined,
                      plan: current.plan ?? undefined,
                      runSuccess: current.runSuccess ?? undefined,
                      stepCount: current.stepCount ?? undefined,
                      runSteps: current.runSteps ?? undefined,
                      runTrace: current.runTrace ?? undefined,
                      evidence: current.evidence ?? undefined,
                      videoKey: current.videoKey ?? undefined,
                      optimizedVideoKey: current.optimizedVideoKey ?? undefined,
                      screenshotKey: current.screenshotKey ?? undefined,
                      error: current.error ?? undefined,
                  },
    };
}
