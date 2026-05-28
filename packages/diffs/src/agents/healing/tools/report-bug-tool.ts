import { AgentTool } from "@autonoma/ai";
import type { z } from "zod";
import { reportBugInputSchema } from "../../../healing/actions";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction } from "./record-action";

export type HealingReportBugInput = z.infer<typeof reportBugInputSchema>;

interface ReportBugOutput {
    testCaseId: string;
}

/** Action tool: report a confirmed application bug, with quarantine + Issue creation. */
export class HealingReportBugTool extends AgentTool<HealingReportBugInput, ReportBugOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "report_bug",
            description:
                "Report a confirmed application bug. Atomic: creates an Issue, links to an existing Bug or creates a new one, and quarantines the test case for this snapshot. The apply layer dedupes against existing bugs and against your other report_bug calls in this batch - just describe each bug you find.",
            inputSchema: reportBugInputSchema,
        });
    }

    protected async execute(input: HealingReportBugInput, loop: HealingAgentLoop): Promise<ReportBugOutput> {
        recordHealingAction(loop, { kind: "report_bug", ...input });
        return { testCaseId: input.testCaseId };
    }
}
