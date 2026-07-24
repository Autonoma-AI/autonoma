import { type Prisma, db } from "@autonoma/db";
import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import type { Logger } from "@autonoma/logger";
import {
    ANALYSIS_VERDICT,
    type AnalysisIssueSeverity,
    analysisIssueSeveritySchema,
    compareAnalysisIssues,
    type CoverageSummary,
    coverageSummarySchema,
    primaryScreenshotSchema,
    type SuspectedCause,
    suspectedCauseSchema,
} from "@autonoma/types";
import type { AnalysisCommentIssue } from "./analysis-comment-payload";

/** The verdict that makes the comment critical - a client bug is the only class that counts against the PR. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/** The issue kind whose open issues the comment cards; environment/scenario issues never block the PR. */
const BUG_KIND = "bug";

/** Everything the analysis PR comment needs from the database, already validated and ordered. */
export interface LoadedAnalysisComment {
    verdict: AppHealthVerdict;
    bugIssues: AnalysisCommentIssue[];
    coverage?: CoverageSummary;
    summary?: string;
}

/** The columns each open bug issue contributes to its card, plus the findings its designated instance is picked from. */
const bugIssueSelect = {
    id: true,
    title: true,
    expectedBehavior: true,
    actualBehavior: true,
    severity: true,
    primaryScreenshot: true,
    suspectedCause: true,
    primaryFindingSlug: true,
    // Every finding attributed to this issue. The designated instance is picked from these in code, because the
    // slug to match on lives on the parent row and a nested Prisma filter cannot reference it.
    findings: {
        select: {
            slug: true,
            findingKey: true,
            clipKey: true,
            reportSnapshotId: true,
            // Findings key to the AnalysisJob, so the run's timestamp comes via the job's snapshot.
            job: { select: { snapshot: { select: { createdAt: true } } } },
        },
    },
} satisfies Prisma.AnalysisIssueSelect;

type BugIssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof bugIssueSelect }>;
type IssueFindingRow = BugIssueRow["findings"][number];

/**
 * Read the persisted run for its PR comment: the app-health verdict, the Reporter's one-paragraph summary, the
 * coverage-plane summary, and the branch's OPEN bug issues (the only ones the comment cards, ordered bugs-first by
 * descending severity via the shared comparator).
 *
 * JSON columns (`coverage`, `primaryScreenshot`, `suspectedCause`) are validated here at the read boundary and
 * degrade to absent on a shape mismatch rather than throwing. Returns undefined when the snapshot has no report -
 * there is nothing to comment on.
 */
export async function loadAnalysisCommentInput(
    snapshotId: string,
    logger: Logger,
): Promise<LoadedAnalysisComment | undefined> {
    const report = await db.analysisReport.findUnique({
        where: { snapshotId },
        select: {
            verdict: true,
            summary: true,
            coverage: true,
            snapshot: { select: { branchId: true } },
        },
    });
    if (report == null) return undefined;

    const bugRows = await db.analysisIssue.findMany({
        where: { branchId: report.snapshot.branchId, status: "open", kind: BUG_KIND },
        select: bugIssueSelect,
    });

    // The two-plane verdict stored as a string; anything other than `client_bug` is the app-health `passed` plane.
    const verdict: AppHealthVerdict = report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed;
    const coverage = coverageSummarySchema.safeParse(report.coverage);
    return {
        verdict,
        // Rows written before the Reporter authored a summary were backfilled to "" - treat empty as absent.
        summary: report.summary !== "" ? report.summary : undefined,
        coverage: coverage.success ? coverage.data : undefined,
        bugIssues: toBugIssues(bugRows, logger),
    };
}

/** Validate + order the open bug issues (descending severity), mapping each to a comment card. */
function toBugIssues(rows: BugIssueRow[], logger: Logger): AnalysisCommentIssue[] {
    const sortable: { card: AnalysisCommentIssue; severity: AnalysisIssueSeverity }[] = [];
    for (const row of rows) {
        const severity = analysisIssueSeveritySchema.safeParse(row.severity);
        if (!severity.success) {
            logger.warn("Skipping bug issue with a malformed severity in the PR comment", {
                extra: { issueId: row.id, severity: row.severity },
            });
            continue;
        }
        const instance = designatedInstance(row);
        sortable.push({
            card: {
                id: row.id,
                title: row.title,
                expectedBehavior: row.expectedBehavior ?? undefined,
                actualBehavior: row.actualBehavior,
                screenshotKey: parsePrimaryScreenshotKey(row.primaryScreenshot),
                clipKey: instance?.clipKey ?? undefined,
                replay:
                    instance != null
                        ? { snapshotId: instance.reportSnapshotId, findingKey: instance.findingKey }
                        : undefined,
                suspectedCause: parseSuspectedCause(row.suspectedCause),
            },
            severity: severity.data,
        });
    }
    sortable.sort((a, b) =>
        compareAnalysisIssues({ kind: "bug", severity: a.severity }, { kind: "bug", severity: b.severity }),
    );
    return sortable.map((entry) => entry.card);
}

/**
 * The run to feature for an issue: the NEWEST finding for the slug the Reporter designated as the clearest
 * reproduction. The agent chose the test; picking its latest run is mechanical, and doing it on read is what makes
 * a carried-forward issue's clip and deep-link track the PR's current head with no re-designation.
 *
 * Absent when the issue predates the designation, or when the designated slug has no attributed finding - the card
 * then falls back to the issue's own hero frame and shows no replay, rather than featuring a run nobody picked.
 */
function designatedInstance(row: BugIssueRow): IssueFindingRow | undefined {
    if (row.primaryFindingSlug == null) return undefined;
    const matching = row.findings.filter((finding) => finding.slug === row.primaryFindingSlug);
    return matching.reduce<IssueFindingRow | undefined>((newest, finding) => {
        if (newest == null) return finding;
        return finding.job.snapshot.createdAt > newest.job.snapshot.createdAt ? finding : newest;
    }, undefined);
}

/** The designated primary screenshot's storage key, when the issue has a well-formed one. */
function parsePrimaryScreenshotKey(json: Prisma.JsonValue): string | undefined {
    const parsed = primaryScreenshotSchema.safeParse(json);
    return parsed.success ? parsed.data.s3Key : undefined;
}

/** The issue's grounded, code-level suspected cause, when it has a well-formed one. */
function parseSuspectedCause(json: Prisma.JsonValue): SuspectedCause | undefined {
    const parsed = suspectedCauseSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
