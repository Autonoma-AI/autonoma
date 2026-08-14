import type { Prisma, PrismaClient } from "@autonoma/db";
import {
    type AnalysisIssueKind,
    type AnalysisIssueSeverity,
    type AnalysisIssueStatus,
    type EvidenceManifestEntry,
    type PrimaryScreenshot,
    type SuspectedCause,
    analysisIssueStatusSchema,
    compareAnalysisIssues,
    pickDesignatedRun,
    primaryScreenshotSchema,
    suspectedCauseSchema,
} from "@autonoma/types";
import { parseIssueEnums } from "../issue-enums";
import { parseEvidenceManifest } from "./evidence-manifest";

export interface CoveredFinding {
    findingId: string;
    testCaseId: string;
    slug: string;
    /** When the Investigator persisted the finding - the issue's "last seen". */
    createdAt: Date;
    snapshotId: string;
    snapshotCreatedAt: Date;
    /** The commit the finding's run judged; absent on snapshots opened without git coordinates. */
    headSha?: string;
    /** Absent on a contained investigation. */
    category?: string;
    headline?: string;
    origin?: string;
    selectionReason?: string;
    clipKey?: string;
}

/** One branch-scoped issue, validated. */
export interface Issue {
    id: string;
    branchId: string;
    title: string;
    kind: AnalysisIssueKind;
    /** Degraded to `low` (and logged) when the stored value does not parse, so a malformed row still resolves. */
    severity: AnalysisIssueSeverity;
    status: AnalysisIssueStatus;
    expectedBehavior?: string;
    actualBehavior: string;
    narrativeMarkdown: string;
    /** Absent when the stored blob does not parse - the caller falls back exactly as it would for no designation. */
    primaryScreenshot?: PrimaryScreenshot;
    suspectedCause?: SuspectedCause;
    primaryTestCaseId?: string;
    /** The assets the narrative embeds by token, validated; empty when absent or malformed. */
    evidenceManifest: EvidenceManifestEntry[];
    resolvedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    /** Across every snapshot of the branch. */
    coveredFindings: CoveredFinding[];
    /** The run to feature as this issue's reproduction; see {@link pickDesignatedRun}. */
    designatedRun?: CoveredFinding;
}

export const issueSelect = {
    id: true,
    branchId: true,
    resolvedAt: true,
    createdAt: true,
    updatedAt: true,
    // Authored content is read through the restatement the issue currently stands behind; only the lifecycle
    // (`resolvedAt`) and the covered set live on the issue itself.
    currentVersion: {
        select: {
            title: true,
            kind: true,
            severity: true,
            expectedBehavior: true,
            actualBehavior: true,
            narrativeMarkdown: true,
            primaryScreenshot: true,
            suspectedCause: true,
            primaryTestCaseId: true,
            evidenceManifest: true,
        },
    },
    findings: {
        select: {
            id: true,
            testCaseId: true,
            createdAt: true,
            reportSnapshotId: true,
            origin: true,
            selectionReason: true,
            testCase: { select: { slug: true } },
            currentClassification: { select: { category: true, headline: true, clipKey: true } },
            job: { select: { snapshot: { select: { createdAt: true, headSha: true } } } },
        },
    },
} satisfies Prisma.AnalysisIssueSelect;

type IssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof issueSelect }>;

export interface ReadIssuesOptions {
    orderBy?: Prisma.AnalysisIssueOrderByWithRelationInput;
    /**
     * Bound applied in SQL. Every issue arrives with its whole covered-finding history joined, so an unbounded
     * read over an application's issues loads every run those issues were ever seen on.
     */
    take?: number;
}

/**
 * An issue's status IS its `resolvedAt`: one timestamp, read two ways, so the two can never contradict each other
 * and an unparseable status cannot exist.
 */
export function issueStatusOf(resolvedAt: Date | null): AnalysisIssueStatus {
    return resolvedAt != null ? analysisIssueStatusSchema.enum.resolved : analysisIssueStatusSchema.enum.open;
}

/** The same fact asked for in SQL: a filter on the status is a filter on `resolvedAt`. */
export function issueStatusFilter(status: AnalysisIssueStatus): Prisma.DateTimeNullableFilter | null {
    return status === analysisIssueStatusSchema.enum.resolved ? { not: null } : null;
}

/**
 * Read issues by an arbitrary scope. Returned in the ledger's canonical order (bugs first, then descending
 * severity, then by id) so no caller re-sorts; `orderBy` still decides which rows a `take` keeps, not how they
 * are handed back.
 */
export async function readIssues(
    db: PrismaClient | Prisma.TransactionClient,
    where: Prisma.AnalysisIssueWhereInput,
    options: ReadIssuesOptions = {},
): Promise<Issue[]> {
    const rows = await db.analysisIssue.findMany({
        where,
        orderBy: options.orderBy ?? { updatedAt: "desc" },
        take: options.take,
        select: issueSelect,
    });
    const issues: Issue[] = [];
    for (const row of rows) {
        const issue = toIssue(row);
        if (issue != null) issues.push(issue);
    }
    return issues.sort(compareIssuesTotally);
}

/**
 * The shared ordering, made total: `compareAnalysisIssues` ranks only kind then severity, and the sort is stable,
 * so without a deterministic tiebreaker two equally-severe bugs could reshuffle between identical reads.
 */
function compareIssuesTotally(left: Issue, right: Issue): number {
    const bySeverity = compareAnalysisIssues(left, right);
    return bySeverity !== 0 ? bySeverity : left.id.localeCompare(right.id);
}

function toIssue(row: IssueRow): Issue | undefined {
    const version = row.currentVersion;
    if (version == null) return undefined;
    const enums = parseIssueEnums({ id: row.id, kind: version.kind, severity: version.severity });
    if (enums == null) return undefined;
    const primaryScreenshot = primaryScreenshotSchema.safeParse(version.primaryScreenshot);
    const suspectedCause = suspectedCauseSchema.safeParse(version.suspectedCause);

    const coveredFindings = row.findings.map(toCoveredFinding);

    return {
        id: row.id,
        branchId: row.branchId,
        title: version.title,
        kind: enums.kind,
        severity: enums.severity,
        status: issueStatusOf(row.resolvedAt),
        expectedBehavior: version.expectedBehavior ?? undefined,
        actualBehavior: version.actualBehavior,
        narrativeMarkdown: version.narrativeMarkdown,
        primaryScreenshot: primaryScreenshot.success ? primaryScreenshot.data : undefined,
        suspectedCause: suspectedCause.success ? suspectedCause.data : undefined,
        primaryTestCaseId: version.primaryTestCaseId ?? undefined,
        evidenceManifest: parseEvidenceManifest(version.evidenceManifest),
        resolvedAt: row.resolvedAt ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        coveredFindings,
        designatedRun: pickDesignatedRun(version.primaryTestCaseId ?? undefined, coveredFindings),
    };
}

function toCoveredFinding(finding: IssueRow["findings"][number]): CoveredFinding {
    return {
        findingId: finding.id,
        testCaseId: finding.testCaseId,
        slug: finding.testCase.slug,
        createdAt: finding.createdAt,
        snapshotId: finding.reportSnapshotId,
        snapshotCreatedAt: finding.job.snapshot.createdAt,
        headSha: finding.job.snapshot.headSha ?? undefined,
        category: finding.currentClassification?.category,
        headline: finding.currentClassification?.headline,
        origin: finding.origin ?? undefined,
        selectionReason: finding.selectionReason ?? undefined,
        clipKey: finding.currentClassification?.clipKey ?? undefined,
    };
}
