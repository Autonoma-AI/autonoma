import type { Issue } from "@autonoma/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import { getAnalysisStore } from "../../services";
import type {
    AnalysisCommentCoverageIssue,
    AnalysisCommentInput,
    AnalysisCommentIssue,
} from "./analysis-comment-payload";

/**
 * Everything the analysis PR comment needs from the database, already validated and ordered - the comment input
 * minus the two fields the poster adds from its own context (the merge-gate flag and the PR page URL), so the
 * shape never drifts from what {@link buildAnalysisCommentPayload} consumes. The loader always resolves the
 * coverage issues (empty when none), so that field is required here even though the comment input allows it absent.
 */
export type LoadedAnalysisComment = Omit<AnalysisCommentInput, "mergeGateBlocking" | "prPageUrl" | "coverageIssues"> & {
    coverageIssues: AnalysisCommentCoverageIssue[];
};

/**
 * Read the persisted run for its PR comment: the PR verdict, the Reporter's title/headline/flows, the coverage-plane
 * summary, the branch's OPEN bug issues (the only ones the comment cards) and the open issues behind the reader's
 * coverage gaps - all through the analysis store, which owns the row interpretation and the order.
 *
 * Ownership itself is not counted here: it rides on each flow, derived from the issue its finding is attributed to.
 * What survives is the issue LIST, which is the reader's "what to fix". Returns undefined when the analysis has no
 * settled report - there is nothing to comment on.
 */
export async function loadAnalysisCommentInput(snapshotId: string): Promise<LoadedAnalysisComment | undefined> {
    const logger = rootLogger.child({ name: "loadAnalysisCommentInput", snapshotId });
    logger.info("Loading analysis PR comment input");
    const analysis = getAnalysisStore().forAnalysis(snapshotId);
    const report = await analysis.report();
    if (report == null) {
        logger.info("No analysis report available for PR comment");
        return undefined;
    }

    // `run` is this snapshot's own plane summary; handing it to the ledger keeps the verdict from summarizing the
    // same snapshot's findings a second time (the branch's latest report IS this run in the comment path).
    const [ledger, run] = await Promise.all([analysis.branch(), analysis.planeSummary()]);
    const [{ verdict, openBugs }, coverageIssues] = await Promise.all([
        ledger.verdictWithOpenBugs({ snapshotId: analysis.snapshotId, summary: run }),
        analysis.clientOwnedCoverageIssues(),
    ]);

    const input = {
        verdict,
        title: report.title,
        headline: report.headline,
        flows: report.flows,
        coverage: run.coverage,
        coverageIssues: coverageIssues.map((gap) => toCoverageCard(gap)),
        bugIssues: toBugIssues(openBugs),
    };
    logger.info("Loaded analysis PR comment input", {
        extra: {
            bugIssueCount: input.bugIssues.length,
            flowCount: input.flows.length,
            coverageIssueCount: input.coverageIssues.length,
        },
    });
    return input;
}

/**
 * Which of the run's coverage gaps the READER owns, from the issues the Reporter attributed them to.
 *
 * `scenario_issue` is theirs by taxonomy. `environment_failure` is not: a preview we could not exercise can be their
 * configuration (a missing flag / SDK key / migration) or our own infrastructure, and the taxonomy deliberately holds
 * no owner field for it. The Reporter's placement is its issue filing - it opens an environment/scenario issue only
 * for a gap the reader can act on - so an env gap attributed to an open one is theirs, and an unattributed gap stays
 * ours.
 *
 * "Unattributed means ours" only holds because a RECURRING gap cannot go unattributed: the Reporter's third coverage
 * guarantee rejects a finish that leaves an open issue uncarried when a covering test hit the same fault again, and
 * carrying it forward re-attributes this run's finding. Weaken that guarantee and a live configuration gap starts
 * reading as our problem on its second run.
 *
 * The store owns the derivation (see `readClientOwnedGaps`); this maps its result to a comment card.
 */
function toCoverageCard(gap: { issueId: string; title: string }): AnalysisCommentCoverageIssue {
    return { id: gap.issueId, title: gap.title };
}

/** Map each open bug issue to a comment card, keeping the ledger's order. */
function toBugIssues(issues: Issue[]): AnalysisCommentIssue[] {
    return issues.map((issue) => {
        const instance = issue.designatedRun;
        return {
            id: issue.id,
            title: issue.title,
            expectedBehavior: issue.expectedBehavior,
            actualBehavior: issue.actualBehavior,
            screenshotKey: issue.primaryScreenshot?.s3Key,
            clipKey: instance?.clipKey,
            replay: instance != null ? { snapshotId: instance.snapshotId, findingId: instance.findingId } : undefined,
            suspectedCause: issue.suspectedCause,
        };
    });
}
