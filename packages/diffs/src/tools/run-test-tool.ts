import { tool } from "ai";
import { z } from "zod";
import type { DiffsAgentCallbacks } from "../callbacks";
import { formatSlugNotFoundError } from "../utils/slug-suggestions";

const runTestSchema = z.object({
    slugs: z.array(z.string()).min(1).describe("The slugs of the test cases to run. Multiple tests run in parallel."),
});

export function buildRunTestTool(callbacks: DiffsAgentCallbacks, completedRuns: Set<string>, validSlugs: Set<string>) {
    const validSlugsList = [...validSlugs];

    return tool({
        description:
            "Run one or more existing tests in parallel to check if they still pass after the code changes. " +
            "Pass an array of slugs to batch tests together for faster execution. " +
            "After running tests, you unlock post-run tools (quarantine_test, bug_found, modify_test) for those tests. " +
            "IMPORTANT: Only use exact slug values from the Existing Tests section. " +
            "Slugs are plain identifiers (e.g. `login-flow`), NOT file paths or filenames.",
        inputSchema: runTestSchema,
        execute: async (input) => {
            const valid: string[] = [];
            const invalid: string[] = [];

            for (const slug of input.slugs) {
                if (validSlugs.has(slug)) {
                    valid.push(slug);
                } else {
                    invalid.push(slug);
                }
            }

            // if there's any invalid slug, we'll send an error so that the agent can rewrite them and not have to wait
            // for the turn to end to fix it.
            if (invalid.length > 0) {
                return { error: formatSlugNotFoundError(invalid, validSlugsList) };
            }

            const results = await callbacks.triggerTestsAndWait(valid);

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
