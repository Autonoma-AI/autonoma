import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { ReporterAgentLoop } from "../reporter-agent-loop";

/** `resolve_issue` input: close an existing issue whose covering test(s) re-ran and passed this job. */
const resolveIssueInputSchema = z.object({
    existingIssueId: z
        .string()
        .describe("The id of the existing open issue to resolve (from the Existing issues list)."),
    resolvingFindingSlug: z
        .string()
        .describe(
            "The slug of THIS job's finding whose test the issue covers and which now PASSED - the proof the problem is gone.",
        ),
    note: z.string().min(1).describe("A one-line note on why the issue is resolved (what now passes)."),
});
type ResolveIssueInput = z.infer<typeof resolveIssueInputSchema>;

type ResolveIssueOutput = { recorded: true; existingIssueId: string };

const DESCRIPTION =
    "Resolve an existing open issue whose covering test(s) re-ran THIS job and passed - the proof the problem is gone. Requires the issue id and the passing finding's slug (which must be a test the issue covers). Resolving is a flip, not a delete: the issue stays on record and reopens if it regresses later.";

/** Records a resolve reconciliation, enforcing that a resolve is backed by a covering test that actually passed. */
export class ResolveIssueTool extends AgentTool<ResolveIssueInput, ResolveIssueOutput, ReporterAgentLoop> {
    constructor() {
        super({ name: "resolve_issue", description: DESCRIPTION, inputSchema: resolveIssueInputSchema });
    }

    protected async execute(input: ResolveIssueInput, loop: ReporterAgentLoop): Promise<ResolveIssueOutput> {
        loop.assertHandleableIssue(input.existingIssueId);
        loop.assertResolvable(input.existingIssueId, input.resolvingFindingSlug);

        loop.recordIssueAction({
            kind: "resolve",
            existingIssueId: input.existingIssueId,
            resolvingFindingSlug: input.resolvingFindingSlug,
            note: input.note,
        });
        return { recorded: true, existingIssueId: input.existingIssueId };
    }
}
