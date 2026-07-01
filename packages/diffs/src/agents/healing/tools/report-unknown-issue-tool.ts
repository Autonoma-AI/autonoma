import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { reportUnknownIssueInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction, resolveReviewLink } from "./record-action";

export type ReportUnknownIssueInput = z.infer<typeof reportUnknownIssueInputSchema>;

interface ReportUnknownIssueOutput {
    testCaseId: string;
}

/**
 * Action tool: report a suspected application issue that could not be grounded
 * in the checked-out code. The downgrade target for a `report_bug` whose cause
 * the agent could not re-ground - records the suspected issue without filing a
 * customer-facing Bug. The test stays in the suite and keeps running every snapshot.
 */
export class ReportUnknownIssueTool extends AgentTool<
    ReportUnknownIssueInput,
    ReportUnknownIssueOutput,
    HealingAgentLoop
> {
    constructor() {
        super({
            name: "report_unknown_issue",
            description:
                "Report a suspected application issue you could NOT ground in the checked-out code. Use this instead of report_bug when you cannot reproduce a concrete code cause. Atomic: creates an Issue with kind=unknown_issue (no customer-facing Bug). The test stays in the suite and keeps running every snapshot - you are recording why it currently fails, not excluding it.",
            inputSchema: reportUnknownIssueInputSchema,
        });
    }

    protected async execute(input: ReportUnknownIssueInput, loop: HealingAgentLoop): Promise<ReportUnknownIssueOutput> {
        const reviewLink = resolveReviewLink(loop, input.testCaseId);
        recordHealingAction(loop, { kind: "report_unknown_issue", ...input, reviewLink });
        return { testCaseId: input.testCaseId };
    }
}
