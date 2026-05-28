import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { ResolutionAgentLoop } from "../resolution-agent-loop";

export const reportBugSchema = z.object({
    runId: z.string().describe("The ID of the run whose review surfaced this bug"),
    slug: z.string().describe("The test slug that exposed this bug"),
    summary: z.string().describe("One-line bug summary"),
    details: z.string().describe("Detailed description of the bug with reproduction context"),
    affectedFiles: z.array(z.string()).describe("Source files related to the bug"),
    fixPrompt: z.string().describe("Suggested fix approach or code change"),
});

export type ReportedBug = z.infer<typeof reportBugSchema>;

interface ReportBugOutput {
    slug: string;
    summary: string;
}

/** Action tool: report an application_bug verdict with codebase context. */
export class ReportBugTool extends AgentTool<ReportedBug, ReportBugOutput, ResolutionAgentLoop> {
    constructor() {
        super({
            name: "report_bug",
            description:
                "Report an application bug found during test replay. " +
                "Use this when the reviewer verdict is 'application_bug' - meaning the test instruction is correct but the application itself has a defect. " +
                "Provide detailed context from your codebase exploration to help developers fix the issue.",
            inputSchema: reportBugSchema,
        });
    }

    protected async execute(input: ReportedBug, loop: ResolutionAgentLoop): Promise<ReportBugOutput> {
        loop.reportedBugs.push(input);
        return { slug: input.slug, summary: input.summary };
    }
}
