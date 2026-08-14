import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import { type CoverageViolations, hasCoverageViolations } from "./coverage";
import type { AuthoredIssueContent } from "./issue-actions";
import type { ReporterAgentLoop } from "./reporter-agent-loop";
import { toPlainSummary } from "./summary";
import type { ReporterIssueContent, ReporterIssueResult, ReporterResult } from "./types";

const reporterFinishInputSchema = z.object({
    title: z
        .string()
        .min(1)
        .describe(
            "The PR's title, about EIGHT WORDS, naming the most useful concrete fact about the state of this PR - not a verdict word. Good: `Checkout and billing verified; search couldn't be reached`. Bad: `Analysis complete`, `Some checks passed`, `Mixed results`. Plain text, no Markdown, no trailing period. Ignored when the PR has an open bug or needed no tests, where we state the outcome ourselves.",
        ),
    headline: z
        .string()
        .min(1)
        .describe(
            "The state of the WHOLE PR in ONE to THREE sentences of plain prose, for readers who see only a paragraph: the GitHub PR comment and the PR page. Cover both sides - what the branch has established across all its commits, and what is still unverified and why - and say whose the unverified part is to fix. Plain prose only: no Markdown headings, no bullet lists, no links, no `evidence:`/`issue:`/`finding:` tokens, none of which render on those surfaces.",
        ),
    flows: z
        .array(
            z.object({
                title: z
                    .string()
                    .min(1)
                    .describe(
                        "The flow's name in the reader's language - a feature or user journey, e.g. `Guest checkout`. Never a test slug and never a file path.",
                    ),
                detail: z
                    .string()
                    .min(1)
                    .describe(
                        "ONE sentence: what this flow was confirmed to do, or why it could not be checked. Do not state whether it counts as verified - that is derived from the tests you cite.",
                    ),
                testSlugs: z
                    .array(z.string())
                    .min(1)
                    .describe("The test slugs this flow covers. Every test must appear in exactly one flow."),
            }),
        )
        .describe(
            "The branch's tests, clustered into the units a reader thinks in. Cluster by what the app DOES, not by outcome: one flow may hold both passing and failing tests, and splitting a feature by result hides that most of it works. Cover every test listed under the branch's tests exactly once.",
        ),
    reportMarkdown: z
        .string()
        .min(1)
        .describe(
            "The holistic PR report in Markdown, for the PR page. This is the DEPTH the flow list cannot carry: what this PR does, the open bugs walked through with their evidence, why the gaps happened, and what changed since the last commit. Do NOT re-list the flows - they are rendered above this from `flows`, and repeating them makes the page read as a duplicate of itself. You may embed a fetched screenshot with `![caption](evidence:<assetId>)` - only fetched ids survive. Never manufacture a problem without a finding.",
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
        if (v.uncoveredIssueFindingSlugs.length > 0) {
            parts.push(
                `These findings must each roll into an issue but none covers them: ${v.uncoveredIssueFindingSlugs.join(", ")}. Every client_bug and every scenario_issue finding is the reader's to fix, so open a new issue or carry forward an existing one that lists each slug.`,
            );
        }
        if (v.uncarriedFailingIssueIds.length > 0) {
            parts.push(
                `These open issues have covering test(s) that re-ran and hit the same problem again, so they must be carried forward: ${v.uncarriedFailingIssueIds.join(", ")}.`,
            );
        }
        if (v.unresolvedPassedIssueIds.length > 0) {
            parts.push(
                `Every covering test of these open issues re-ran and passed, so they must be resolved: ${v.unresolvedPassedIssueIds.join(", ")}.`,
            );
        }
        return `Cannot finish yet. ${parts.join(" ")}`;
    }
}

/** The authored surfaces that must survive sanitizing, and what a reader would lose if one did not. */
const PROSE_SURFACES = [
    { key: "title", label: "the PR's title" },
    { key: "headline", label: "the PR's headline" },
    { key: "reportMarkdown", label: "the report" },
] as const;

type ProseSurfaces = Record<(typeof PROSE_SURFACES)[number]["key"], string>;

/**
 * Reject a finish whose prose survives validation but not sanitizing.
 *
 * The input schema's `min(1)` accepts a string like `"![shot](evidence:a1)"` or `"#  "`, and flattening then strips it
 * to nothing - so a run can pass validation and still persist a blank heading. Caught HERE, where the value is
 * created, so no read site downstream has to translate an empty string back into "absent": these columns are
 * non-empty by construction, and every surface can render what it reads.
 */
function assertProseSurvived(prose: ProseSurfaces): void {
    const emptied = PROSE_SURFACES.filter((surface) => prose[surface.key] === "");
    if (emptied.length === 0) return;
    const named = emptied.map((surface) => surface.label).join(" and ");
    throw new FixableToolError(
        `Nothing was left of ${named} after sanitizing. Those surfaces render plain text: a heading marker, a bare image or a lone link is stripped entirely. Write them as prose and finish again.`,
    );
}

/**
 * Terminal tool for the {@link ReporterAgent}. Before it accepts the report, it enforces the three coverage
 * guarantees (every live client bug and scenario gap covered; every open issue whose WHOLE covered set passed resolved;
 * every open issue whose covering test hit the same problem again carried forward) as a fixable retry, then grounds
 * every authored surface at persist time: unbacked evidence images are stripped, `suspectedCause` references are
 * validated against the checked-out repo, and a hero screenshot resolves only from a fetched asset. So the result the
 * caller gets can never surface an image the agent did not fetch or a code reference that is not really there.
 *
 * The flows get the same treatment by a different mechanism. The agent names them and cites the tests each covers;
 * whether a flow counts as verified, and whose its gaps are, is derived from those tests here. An agent that could
 * author its own status could promote a flow with a failed check to "verified" - the one thing this stage cannot be
 * allowed to do. Unlike the coverage guarantees, a bad PARTITION is corrected rather than rejected: it costs a good
 * name, never a verdict, so failing the run over one would trade a whole PR comment for a nicer label.
 */
export class ReporterResultTool extends ReportResultTool<ReporterFinishInput, ReporterResult, ReporterAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Finish the report. Rejected until every client_bug and every scenario_issue finding is covered by an issue, every open issue whose covering tests ALL re-ran and passed is resolved, and every open issue whose covering test hit the same problem again is carried forward.",
            inputSchema: reporterFinishInputSchema,
        });
    }

    async buildResult(input: ReporterFinishInput, loop: ReporterAgentLoop): Promise<ReporterResult> {
        const violations = loop.checkCoverage();
        if (hasCoverageViolations(violations)) throw new CoverageError(violations);

        const issues = loop.issueActions.map((action) => this.resolveIssue(action, loop));
        const { markdown, manifest } = loop.groundNarrative(input.reportMarkdown);
        const { flows, ...flowCorrections } = loop.partitionFlows(input.flows);
        // Both authored strings land on surfaces that render neither block Markdown nor our tokens, so both are
        // flattened rather than trusted - the prompt asks for plain prose, and this is what guarantees it.
        const title = toPlainSummary(input.title);
        const headline = toPlainSummary(input.headline);
        assertProseSurvived({ title, headline, reportMarkdown: markdown });

        return {
            title,
            headline,
            flows,
            flowCorrections,
            reportMarkdown: markdown,
            reportEvidenceManifest: manifest,
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
