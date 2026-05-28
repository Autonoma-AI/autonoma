import type { LanguageModel } from "@autonoma/ai";
import { Codebase, ReplayReviewer, type RunContext, type RunStepData } from "@autonoma/diffs";
import { LocalStorageProvider } from "@autonoma/storage/local";
import type { ReplayVerdict } from "@autonoma/types";

export interface LocalReviewInput {
    /** Slug of the test that was reviewed */
    testSlug: string;
    /** The original test instruction */
    testInstruction: string;
    /** The test name */
    testName: string;
    /** Path to the artifact directory from test execution */
    artifactDir: string;
    /** Path to the source tree the reviewer should inspect alongside the visual evidence. */
    repoDir: string;
    /** Steps from the execution result */
    steps: RunStepData[];
}

export interface LocalReviewResult {
    testSlug: string;
    verdict?: ReplayVerdict;
}

export async function runReviewLocally(model: LanguageModel, input: LocalReviewInput): Promise<LocalReviewResult> {
    const storage = new LocalStorageProvider(input.artifactDir);
    const evidenceLoader = {
        loadScreenshot: (key: string) => storage.download(key),
        downloadVideo: (key: string) => storage.download(key),
    };

    const reviewer = new ReplayReviewer({ model, evidenceLoader });
    const codebase = new Codebase(input.repoDir);

    const lastStep = input.steps[input.steps.length - 1];
    const finalScreenshotKey = lastStep?.screenshotAfterKey ?? lastStep?.screenshotBeforeKey;

    const context: RunContext = {
        runId: input.testSlug,
        organizationId: "local",
        testPlanPrompt: input.testInstruction,
        testCaseName: input.testName,
        steps: input.steps,
        finalScreenshotKey,
    };

    try {
        const { result: verdict } = await reviewer.run({ context, codebase });
        return { testSlug: input.testSlug, verdict };
    } catch (err) {
        // The reviewer throws when the agent reaches max steps without submitting a verdict.
        // Locally we surface that as `undefined` so the CLI can report "no verdict" without aborting.
        console.warn(
            `[run-review-locally] reviewer did not produce a verdict for ${input.testSlug}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { testSlug: input.testSlug, verdict: undefined };
    }
}
