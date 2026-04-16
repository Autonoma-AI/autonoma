import type { LanguageModel } from "@autonoma/ai";
import type { RunReviewData, RunStepData } from "@autonoma/replay-reviewer/data-loader";
import { ReplayReviewer } from "@autonoma/replay-reviewer/reviewer";
import { LocalStorageProvider } from "@autonoma/storage/local";
import type { ReviewVerdict } from "@autonoma/types";

export interface LocalReviewInput {
    /** Slug of the test that was reviewed */
    testSlug: string;
    /** The original test instruction */
    testInstruction: string;
    /** The test name */
    testName: string;
    /** Path to the artifact directory from test execution */
    artifactDir: string;
    /** Steps from the execution result */
    steps: RunStepData[];
}

export interface LocalReviewResult {
    testSlug: string;
    verdict?: ReviewVerdict;
}

export async function runReviewLocally(model: LanguageModel, input: LocalReviewInput): Promise<LocalReviewResult> {
    const storage = new LocalStorageProvider(input.artifactDir);
    const dataLoader = {
        loadScreenshot: (key: string) => storage.download(key),
        downloadVideo: (key: string) => storage.download(key),
    };

    const reviewer = new ReplayReviewer(model, dataLoader);

    const lastStep = input.steps[input.steps.length - 1];
    const finalScreenshotKey = lastStep?.screenshotAfterKey ?? lastStep?.screenshotBeforeKey;

    const data: RunReviewData = {
        runId: input.testSlug,
        organizationId: "local",
        testPlanPrompt: input.testInstruction,
        testCaseName: input.testName,
        steps: input.steps,
        finalScreenshotKey,
    };

    const result = await reviewer.review(data);

    return { testSlug: input.testSlug, verdict: result.verdict };
}
