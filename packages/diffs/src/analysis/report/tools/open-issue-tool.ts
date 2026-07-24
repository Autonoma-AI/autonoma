import { AgentTool } from "@autonoma/ai";
import {
    assertPrimaryFindingSlugCovered,
    type AuthoredIssueContent,
    authoredIssueContentSchema,
} from "../issue-actions";
import type { ReporterAgentLoop } from "../reporter-agent-loop";

type OpenIssueOutput = { recorded: true; findingSlugs: string[] };

const DESCRIPTION =
    "Open a NEW branch-scoped issue for a problem this job surfaced that no existing issue already covers. All fields are required (kind, severity, expected/actual, narrative, and the finding slugs it covers). Never open an issue without a finding to back it - you are a synthesizer of the findings, not an investigator that manufactures problems. If the same problem is an existing issue, use carry_forward_issue instead.";

/**
 * Records a new-issue reconciliation. Its input IS the shared authored-issue content verbatim (a brand-new issue,
 * all content fields required); the grounding of its narrative/hero happens at finish, not here.
 */
export class OpenIssueTool extends AgentTool<AuthoredIssueContent, OpenIssueOutput, ReporterAgentLoop> {
    constructor() {
        super({ name: "open_issue", description: DESCRIPTION, inputSchema: authoredIssueContentSchema });
    }

    protected async execute(input: AuthoredIssueContent, loop: ReporterAgentLoop): Promise<OpenIssueOutput> {
        loop.assertKnownFindingSlugs(input.findingSlugs);
        loop.assertKnownAsset(input.primaryScreenshotAssetId);
        assertPrimaryFindingSlugCovered(input);
        loop.recordIssueAction({ kind: "open", content: input });
        return { recorded: true, findingSlugs: input.findingSlugs };
    }
}
