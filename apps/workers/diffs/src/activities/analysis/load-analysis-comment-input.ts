import { type Prisma, db } from "@autonoma/db";
import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    ANALYSIS_VERDICT,
    type AnalysisIssueKind,
    type AnalysisIssueSeverity,
    analysisCoverageOwner,
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
    compareAnalysisIssues,
    type CoverageSummary,
    coverageSummarySchema,
    pickDesignatedRun,
    primaryScreenshotSchema,
    type SuspectedCause,
    suspectedCauseSchema,
} from "@autonoma/types";
import type { AnalysisCommentCoverageIssue, AnalysisCommentIssue } from "./analysis-comment-payload";

/** The verdict that makes the comment critical - a client bug is the only class that counts against the PR. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/** The issue kind whose open issues the comment cards; environment/scenario issues never block the PR. */
const BUG_KIND = analysisIssueKindSchema.enum.bug;

/** The status of an issue that is still live - the only one the comment surfaces. */
const OPEN = "open";

/** Where a coverage issue whose stored severity does not parse sorts - listed, but last (as the merge gate does). */
const UNPARSED_SEVERITY: AnalysisIssueSeverity = analysisIssueSeveritySchema.enum.low;

/** Everything the analysis PR comment needs from the database, already validated and ordered. */
export interface LoadedAnalysisComment {
    verdict: AppHealthVerdict;
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised (no tests affected). */
    testCount: number;
    bugIssues: AnalysisCommentIssue[];
    coverage?: CoverageSummary;
    /** How many of this run's `environment_failure` gaps the Reporter placed on the reader's side. */
    clientEnvironmentFailures: number;
    /** The open issues behind this run's client-owned coverage gaps, most actionable first. */
    coverageIssues: AnalysisCommentCoverageIssue[];
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

/** Each of the run's coverage gaps with the branch issue the Reporter attributed it to, which is what owns it. */
const coverageGapSelect = {
    currentClassification: { select: { category: true } },
    issue: { select: { id: true, title: true, kind: true, severity: true, status: true } },
} satisfies Prisma.AnalysisFindingSelect;

type CoverageGapRow = Prisma.AnalysisFindingGetPayload<{ select: typeof coverageGapSelect }>;

/**
 * Read the persisted run for its PR comment: the app-health verdict, the Reporter's one-paragraph summary, the
 * coverage-plane summary, the branch's OPEN bug issues (the only ones the comment cards, ordered bugs-first by
 * descending severity via the shared comparator), and the owner split of the coverage gaps the body groups by.
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

    const [bugRows, gapRows] = await Promise.all([
        db.analysisIssue.findMany({
            where: { branchId: report.snapshot.branchId, status: OPEN, kind: BUG_KIND },
            select: bugIssueSelect,
        }),
        db.analysisFinding.findMany({
            where: { reportSnapshotId: snapshotId, currentClassificationId: { not: null } },
            // The issue list below breaks ties by first appearance, so the query has to have a stable order of its own.
            orderBy: { testCase: { slug: "asc" } },
            select: coverageGapSelect,
        }),
    ]);

    // The two-plane verdict stored as a string; anything other than `client_bug` is the app-health `passed` plane.
    const verdict: AppHealthVerdict = report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed;
    const coverage = coverageSummarySchema.safeParse(report.coverage);
    const clientOwned = resolveClientOwnedGaps(gapRows, logger);
    const input = {
        verdict,
        testCount: report.testCount,
        // Rows written before the Reporter authored a summary were backfilled to "" - treat empty as absent.
        summary: report.summary !== "" ? report.summary : undefined,
        coverage: coverage.success ? coverage.data : undefined,
        clientEnvironmentFailures: clientOwned.environmentFailures,
        coverageIssues: clientOwned.issues,
        bugIssues: toBugIssues(bugRows, snapshotId),
    };
    logger.info("Loaded analysis PR comment input", {
        extra: {
            bugIssueCount: input.bugIssues.length,
            clientEnvironmentFailures: input.clientEnvironmentFailures,
            coverageIssueCount: input.coverageIssues.length,
        },
    });
    return input;
}

/** The client-owned share of the run's coverage gaps: the env count on their side, and the issues behind the gaps. */
interface ClientOwnedGaps {
    environmentFailures: number;
    issues: AnalysisCommentCoverageIssue[];
}

/**
 * Resolve which of the run's coverage gaps the READER owns, from the issues the Reporter attributed them to.
 *
 * `scenario_issue` is theirs by taxonomy. `environment_failure` is not: a preview we could not exercise can be their
 * configuration (a missing flag / SDK key / migration) or our own infrastructure, and the taxonomy deliberately holds
 * no owner field for it. The Reporter's placement is its issue filing - it opens an environment/scenario issue only
 * for a gap the reader can act on - so an env gap attributed to an open one is theirs, and an unattributed gap stays
 * ours. The issues behind those gaps come back with it, ordered by the shared comparator, as the "what to fix" list.
 *
 * "Unattributed means ours" only holds because a RECURRING gap cannot go unattributed: the Reporter's third coverage
 * guarantee rejects a finish that leaves an open issue uncarried when a covering test hit the same fault again, and
 * carrying it forward re-attributes this run's finding. Weaken that guarantee and a live configuration gap starts
 * reading as our problem on its second run.
 */
function resolveClientOwnedGaps(rows: CoverageGapRow[], logger: Logger): ClientOwnedGaps {
    let environmentFailures = 0;
    const issues = new Map<
        string,
        { card: AnalysisCommentCoverageIssue; kind: AnalysisIssueKind; severity: AnalysisIssueSeverity }
    >();

    for (const row of rows) {
        const category = row.currentClassification?.category;
        if (category == null) continue;
        const owner = analysisCoverageOwner(category);
        if (owner !== "client" && owner !== "undecided") continue;

        const issue = parseCoverageIssue(row.issue, logger);
        if (owner === "undecided") {
            if (issue == null) continue;
            environmentFailures += 1;
        }
        if (issue != null) issues.set(issue.card.id, issue);
    }

    const ordered = [...issues.values()].sort((a, b) => compareAnalysisIssues(a, b)).map((entry) => entry.card);
    return { environmentFailures, issues: ordered };
}

/**
 * An attributed issue, when it is a live one the reader owns (open, and not a bug - bugs have their own cards).
 *
 * A malformed severity only costs the row its place in the ordering, never its place in the block: severity decides
 * where a gap sorts, `kind` decides whose it is, and dropping the row would silently move its gap onto our side. A
 * malformed KIND is different - it is the ownership signal itself, so an unreadable one is skipped rather than guessed.
 */
function parseCoverageIssue(
    issue: CoverageGapRow["issue"],
    logger: Logger,
): { card: AnalysisCommentCoverageIssue; kind: AnalysisIssueKind; severity: AnalysisIssueSeverity } | undefined {
    if (issue == null || issue.status !== OPEN) return undefined;
    const kind = analysisIssueKindSchema.safeParse(issue.kind);
    if (!kind.success) {
        logger.warn("Skipping a coverage issue with a malformed kind in the PR comment", {
            extra: { issueId: issue.id, kind: issue.kind },
        });
        return undefined;
    }
    const severity = analysisIssueSeveritySchema.safeParse(issue.severity);
    if (!severity.success) {
        logger.warn("Sorting a coverage issue with a malformed severity last in the PR comment", {
            extra: { issueId: issue.id, severity: issue.severity },
        });
    }
    if (kind.data === BUG_KIND) return undefined;
    return {
        card: { id: issue.id, title: issue.title },
        kind: kind.data,
        severity: severity.success ? severity.data : UNPARSED_SEVERITY,
    };
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
