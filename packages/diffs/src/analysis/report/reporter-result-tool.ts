import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import { type CoverageViolations, hasCoverageViolations } from "./coverage";
import type { AuthoredIssueContent } from "./issue-actions";
import type { ReporterAgentLoop } from "./reporter-agent-loop";
import { toPlainSummary } from "./summary";
import type { ReporterIssueContent, ReporterIssueResult, ReporterResult } from "./types";

const reporterFinishInputSchema = z.object({
    reportMarkdown: z
        .string()
        .min(1)
        .describe(
            "The holistic PR report in Markdown: what this PR does, what the run found across all tests, the open bugs first (headline), then environment/scenario/coverage color, and a brief note on any self-heals. Lead with the latest job. You may embed a fetched screenshot inline with `![caption](evidence:<assetId>)` - only fetched ids survive. Never manufacture a problem without a finding.",
        ),
    summary: z
        .string()
        .min(1)
        .describe(
            "The same verdict in ONE to THREE sentences of plain prose, for readers who see only a paragraph: the GitHub PR comment and the PR page's subtitle. Lead with whether the app misbehaved and what breaks for a user. Plain prose only - no Markdown headings, no bullet lists, no links, and no `evidence:`/`issue:`/`finding:` tokens, none of which render on those surfaces.",
        ),
});

type ReporterFinishInput = z.infer<typeof reporterFinishInputSchema>;

/** Fires when a finish attempt violates a coverage guarantee, telling the model exactly what to fix and retry. */
class CoverageError extends FixableToolError {
    constructor(violations: CoverageViolations) {
        super(CoverageError.describe(violations));
    }

    private static describe(v: CoverageViolations): string {
        const parts: string[] = [];
        if (v.uncoveredBugSlugs.length > 0) {
            parts.push(
                `These client_bug findings are not covered by any issue: ${v.uncoveredBugSlugs.join(", ")}. Open a new issue or carry forward an existing one that lists each slug.`,
            );
        }
        if (v.uncarriedFailingIssueIds.length > 0) {
            parts.push(
                `These open issues have covering test(s) that re-ran and still failed, so they must be carried forward: ${v.uncarriedFailingIssueIds.join(", ")}.`,
            );
        }
        if (v.unresolvedPassedIssueIds.length > 0) {
            parts.push(
                `These open issues have covering test(s) that re-ran and passed, so they must be resolved: ${v.unresolvedPassedIssueIds.join(", ")}.`,
            );
        }
        return `Cannot finish yet. ${parts.join(" ")}`;
    }
}

/**
 * Terminal tool for the {@link ReporterAgent}. Before it accepts the report, it enforces the three coverage
 * guarantees (every live bug covered; every open issue whose test passed resolved; every open issue whose test
 * still failed carried forward) as a fixable retry, then grounds every authored surface at persist time: unbacked
 * evidence images are stripped, `suspectedCause` references are validated against the checked-out repo, and a hero
 * screenshot resolves only from a fetched asset. So the result the caller gets can never surface an image the
 * agent did not fetch or a code reference that is not really there.
 */
export class ReporterResultTool extends ReportResultTool<ReporterFinishInput, ReporterResult, ReporterAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Finish the report. Rejected until every client_bug finding is covered by an issue, every open issue whose covering test(s) passed is resolved, and every open issue whose covering test(s) still failed is carried forward.",
            inputSchema: reporterFinishInputSchema,
        });
    }

    async buildResult(input: ReporterFinishInput, loop: ReporterAgentLoop): Promise<ReporterResult> {
        const violations = loop.checkCoverage();
        if (hasCoverageViolations(violations)) throw new CoverageError(violations);

        const issues = loop.issueActions.map((action) => this.resolveIssue(action, loop));
        const { markdown, manifest } = loop.groundNarrative(input.reportMarkdown);
        return {
            reportMarkdown: markdown,
            reportEvidenceManifest: manifest,
            summary: toPlainSummary(input.summary),
            issues,
        };
    }

    /** Turn one recorded reconciliation into its grounded, persisted result shape. */
    private resolveIssue(
        action: ReporterAgentLoop["issueActions"][number],
        loop: ReporterAgentLoop,
    ): ReporterIssueResult {
        if (action.kind === "resolve") {
            return {
                kind: "resolve",
                existingIssueId: action.existingIssueId,
                resolvingFindingSlug: action.resolvingFindingSlug,
                note: action.note,
            };
        }
        const content = this.groundContent(action.content, loop);
        if (action.kind === "open") return { kind: "open", content };
        return { kind: "carry_forward", existingIssueId: action.existingIssueId, content };
    }

    /** Ground an authored issue's narrative, suspected cause, and hero screenshot against what was really fetched. */
    private groundContent(content: AuthoredIssueContent, loop: ReporterAgentLoop): ReporterIssueContent {
        const grounded = loop.groundNarrative(content.narrativeMarkdown);
        return {
            title: content.title,
            kind: content.kind,
            severity: content.severity,
            expectedBehavior: content.expectedBehavior,
            actualBehavior: content.actualBehavior,
            narrativeMarkdown: grounded.markdown,
            evidenceManifest: grounded.manifest,
            suspectedCause: loop.validateSuspectedCause(content.suspectedCause),
            primaryScreenshot: loop.resolvePrimaryScreenshot(content.primaryScreenshotAssetId),
            findingSlugs: content.findingSlugs,
            primaryFindingSlug: content.primaryFindingSlug,
        };
    }
}
