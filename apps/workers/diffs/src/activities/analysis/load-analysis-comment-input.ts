import { type Prisma, db } from "@autonoma/db";
import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import {
    ANALYSIS_VERDICT,
    type AnalysisIssueSeverity,
    analysisIssueSeveritySchema,
    compareAnalysisIssues,
    type CoverageSummary,
    coverageSummarySchema,
    pickDesignatedRun,
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
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised (no tests affected). */
    testCount: number;
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
    primaryTestCaseId: true,
    // Every finding attributed to this issue. The designated instance is picked from these in code, because the
    // test to match on lives on the parent row and a nested Prisma filter cannot reference it.
    findings: {
        select: {
            id: true,
            testCaseId: true,
            reportSnapshotId: true,
            currentClassification: { select: { clipKey: true } },
            // Findings key to the AnalysisJob, so the run's timestamp comes via the job's snapshot.
            job: { select: { snapshot: { select: { createdAt: true } } } },
        },
    },
} satisfies Prisma.AnalysisIssueSelect;

type BugIssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof bugIssueSelect }>;

/**
 * Read the persisted run for its PR comment: the app-health verdict, the Reporter's one-paragraph summary, the
 * coverage-plane summary, and the branch's OPEN bug issues (the only ones the comment cards, ordered bugs-first by
 * descending severity via the shared comparator).
 *
 * JSON columns (`coverage`, `primaryScreenshot`, `suspectedCause`) are validated here at the read boundary and
 * degrade to absent on a shape mismatch rather than throwing. Returns undefined when the snapshot has no report -
 * there is nothing to comment on.
 */
export async function loadAnalysisCommentInput(snapshotId: string): Promise<LoadedAnalysisComment | undefined> {
    const logger = rootLogger.child({ name: "loadAnalysisCommentInput", snapshotId });
    logger.info("Loading analysis PR comment input");
    const report = await db.analysisReport.findUnique({
        where: { snapshotId },
        select: {
            verdict: true,
            testCount: true,
            summary: true,
            coverage: true,
            snapshot: { select: { branchId: true } },
        },
    });
    if (report == null) {
        logger.info("No analysis report available for PR comment");
        return undefined;
    }

    const bugRows = await db.analysisIssue.findMany({
        where: { branchId: report.snapshot.branchId, status: "open", kind: BUG_KIND },
        select: bugIssueSelect,
    });

    // The two-plane verdict stored as a string; anything other than `client_bug` is the app-health `passed` plane.
    const verdict: AppHealthVerdict = report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed;
    const coverage = coverageSummarySchema.safeParse(report.coverage);
    const input = {
        verdict,
        testCount: report.testCount,
        // Rows written before the Reporter authored a summary were backfilled to "" - treat empty as absent.
        summary: report.summary !== "" ? report.summary : undefined,
        coverage: coverage.success ? coverage.data : undefined,
        bugIssues: toBugIssues(bugRows, snapshotId),
    };
    logger.info("Loaded analysis PR comment input", { extra: { bugIssueCount: input.bugIssues.length } });
    return input;
}

/** Validate + order the open bug issues (descending severity), mapping each to a comment card. */
function toBugIssues(rows: BugIssueRow[], snapshotId: string): AnalysisCommentIssue[] {
    const logger = rootLogger.child({ name: "toBugIssues", snapshotId });
    const sortable: { card: AnalysisCommentIssue; severity: AnalysisIssueSeverity }[] = [];
    for (const row of rows) {
        const severity = analysisIssueSeveritySchema.safeParse(row.severity);
        if (!severity.success) {
            logger.warn("Skipping bug issue with a malformed severity in the PR comment", {
                extra: { issueId: row.id, severity: row.severity },
            });
            continue;
        }
        const instance = pickDesignatedRun(row.primaryTestCaseId ?? undefined, row.findings);
        sortable.push({
            card: {
                id: row.id,
                title: row.title,
                expectedBehavior: row.expectedBehavior ?? undefined,
                actualBehavior: row.actualBehavior,
                screenshotKey: parsePrimaryScreenshotKey(row.primaryScreenshot),
                clipKey: instance?.currentClassification?.clipKey ?? undefined,
                replay:
                    instance != null ? { snapshotId: instance.reportSnapshotId, findingId: instance.id } : undefined,
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
