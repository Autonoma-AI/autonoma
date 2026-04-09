import { tool } from "ai";
import { z } from "zod";
import type { DiffsAgentCallbacks } from "../callbacks";

const runTestSchema = z.object({
    slugs: z.array(z.string()).min(1).describe("The slugs of the test cases to run. Multiple tests run in parallel."),
});

export function buildRunTestTool(callbacks: DiffsAgentCallbacks, completedRuns: Set<string>) {
    return tool({
        description:
            "Run one or more existing tests in parallel to check if they still pass after the code changes. " +
            "Pass an array of slugs to batch tests together for faster execution. " +
            "After running tests, you unlock post-run tools (quarantine_test, bug_found, modify_test) for those tests.",
        inputSchema: runTestSchema,
        execute: async (input) => {
            const results = await callbacks.triggerTestsAndWait(input.slugs);

            for (const result of results) {
                completedRuns.add(result.slug);
            }

            return results.map((result) => ({
                slug: result.slug,
                testName: result.testName,
                success: result.success,
                finishReason: result.finishReason,
                reasoning: result.reasoning,
                stepDescriptions: result.stepDescriptions,
                videoUrl: result.videoUrl,
                screenshotUrls: result.screenshotUrls,
            }));
        },
    });
}
