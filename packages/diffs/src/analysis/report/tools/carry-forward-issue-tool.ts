import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import { assertPrimaryFindingSlugCovered, authoredIssueContentSchema } from "../issue-actions";
import type { ReporterAgentLoop } from "../reporter-agent-loop";

/** `carry_forward_issue` input: the shared authored content plus the existing issue id being re-confirmed. */
const carryForwardIssueInputSchema = authoredIssueContentSchema.extend({
    existingIssueId: z
        .string()
        .describe(
            "The id of the existing issue this job re-confirms (from the Existing issues list). Reopens it if it was resolved.",
        ),
});
type CarryForwardIssueInput = z.infer<typeof carryForwardIssueInputSchema>;

type CarryForwardIssueOutput = { recorded: true; existingIssueId: string };

const DESCRIPTION =
    "Re-confirm an EXISTING issue that this job's evidence shows is still present, restating its full content and adding this job's finding slugs. This is also the reopen path: use it when a previously-resolved issue regressed. Requires the existing issue id. Restate the content fresh from the current evidence - do not assume the old narrative still reads correctly.";

/** Records a carry-forward (re-confirm/reopen) reconciliation for an existing issue. */
export class CarryForwardIssueTool extends AgentTool<
    CarryForwardIssueInput,
    CarryForwardIssueOutput,
    ReporterAgentLoop
> {
    constructor() {
        super({ name: "carry_forward_issue", description: DESCRIPTION, inputSchema: carryForwardIssueInputSchema });
    }

    protected async execute(input: CarryForwardIssueInput, loop: ReporterAgentLoop): Promise<CarryForwardIssueOutput> {
        loop.assertHandleableIssue(input.existingIssueId);
        loop.assertKnownFindingSlugs(input.findingSlugs);
        loop.assertKnownAsset(input.primaryScreenshotAssetId);

        const { existingIssueId, ...content } = input;
        assertPrimaryFindingSlugCovered(content);
        loop.recordIssueAction({ kind: "carry_forward", existingIssueId, content });
        return { recorded: true, existingIssueId };
    }
}
