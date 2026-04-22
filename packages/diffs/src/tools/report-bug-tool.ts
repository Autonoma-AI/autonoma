import { tool } from "ai";
import { z } from "zod";

export const reportBugSchema = z.object({
    runId: z.string().describe("The ID of the run whose review surfaced this bug"),
    slug: z.string().describe("The test slug that exposed this bug"),
    summary: z.string().describe("One-line bug summary"),
    details: z.string().describe("Detailed description of the bug with reproduction context"),
    affectedFiles: z.array(z.string()).describe("Source files related to the bug"),
    fixPrompt: z.string().describe("Suggested fix approach or code change"),
});

export type ReportedBug = z.infer<typeof reportBugSchema>;

export interface ReportedBugCollector {
    reportedBugs: ReportedBug[];
}

export function buildReportBugTool(collector: ReportedBugCollector) {
    return tool({
        description:
            "Report an application bug found during test replay. " +
            "Use this when the reviewer verdict is 'application_bug' - meaning the test instruction is correct but the application itself has a defect. " +
            "Provide detailed context from your codebase exploration to help developers fix the issue.",
        inputSchema: reportBugSchema,
        execute: async (input) => {
            collector.reportedBugs.push(input);
            return { success: true, slug: input.slug, summary: input.summary };
        },
    });
}
