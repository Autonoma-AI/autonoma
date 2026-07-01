import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { reportBugInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction, resolveReviewLink } from "./record-action";

export type HealingReportBugInput = z.infer<typeof reportBugInputSchema>;

interface ReportBugOutput {
    testCaseId: string;
}

/** Action tool: report a confirmed application bug; files the Issue + Bug while the test keeps running. */
export class HealingReportBugTool extends AgentTool<HealingReportBugInput, ReportBugOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "report_bug",
            description:
                "Report a confirmed application bug. Atomic: creates an Issue and links to an existing Bug or creates a new one. The test stays in the suite and keeps running every snapshot - you are recording why it currently fails, not excluding it, so a later fix is observed when it passes again. The apply layer dedupes against existing bugs and against your other report_bug calls in this batch - just describe each bug you find.",
            inputSchema: reportBugInputSchema,
        });
    }

    protected async execute(input: HealingReportBugInput, loop: HealingAgentLoop): Promise<ReportBugOutput> {
        const reviewLink = resolveReviewLink(loop, input.testCaseId);
        recordHealingAction(loop, { kind: "report_bug", ...input, reviewLink });
        return { testCaseId: input.testCaseId };
    }
}
