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
    const [{ verdict, openBugs }, coverageIssues, openIssueCount] = await Promise.all([
        ledger.verdictWithOpenBugs({ snapshotId: analysis.snapshotId, summary: run }),
        analysis.clientOwnedCoverageIssues(),
        ledger.openIssueCount(),
    ]);

    const input = {
        verdict,
        title: report.title,
        headline: report.headline,
        flows: report.flows,
        coverage: run.coverage,
        coverageIssues: coverageIssues.map((issue) => toCoverageCard(issue)),
        bugIssues: toBugIssues(openBugs),
        openIssueCount,
    };
    logger.info("Loaded analysis PR comment input", {
        extra: {
            bugIssueCount: input.bugIssues.length,
            flowCount: input.flows.length,
            coverageIssueCount: input.coverageIssues.length,
            openIssueCount,
        },
    });
    return input;
}

/**
 * Map a client-owned-gap issue to its comment card: title, the reader-facing description, and the Reporter's
 * designated run for the representative frame + "Watch replay". The store owns WHICH issues are the reader's - the
 * scenario/environment ownership derivation lives in `readClientOwnedGaps`.
 */
function toCoverageCard(issue: Issue): AnalysisCommentCoverageIssue {
    const instance = issue.designatedRun;
    return {
        id: issue.id,
        title: issue.title,
        actualBehavior: issue.actualBehavior,
        screenshotKey: issue.primaryScreenshot?.s3Key,
        clipKey: instance?.clipKey,
        replay: instance != null ? { snapshotId: instance.snapshotId, findingId: instance.findingId } : undefined,
    };
}

/** Map each open bug issue to a comment card, keeping the ledger's order. */
function toBugIssues(issues: Issue[]): AnalysisCommentIssue[] {
    return issues.map((issue) => {
        const instance = issue.designatedRun;
        return {
            id: issue.id,
            title: issue.title,
            actualBehavior: issue.actualBehavior,
            screenshotKey: issue.primaryScreenshot?.s3Key,
            clipKey: instance?.clipKey,
            replay: instance != null ? { snapshotId: instance.snapshotId, findingId: instance.findingId } : undefined,
            suspectedCause: issue.suspectedCause,
        };
    });
}
