import type { AffectedReason, RunReviewVerdict } from "@autonoma/diffs";
import type { ReviewVerdict } from "@autonoma/types";

export interface VerdictMappingInput {
    testSlug: string;
    testName: string;
    originalPrompt: string;
    runStatus?: string;
    affectedReason?: AffectedReason;
}

export function mapVerdictToResolutionInput(test: VerdictMappingInput, verdict: ReviewVerdict): RunReviewVerdict {
    return {
        runId: test.testSlug,
        testSlug: test.testSlug,
        testName: test.testName,
        originalPrompt: test.originalPrompt,
        runStatus: test.runStatus ?? "failed",
        verdict: verdict.verdict,
        reviewReasoning: verdict.reasoning,
        issueTitle: verdict.title,
        issueConfidence: verdict.confidence,
        issueDescription: verdict.reasoning,
        affectedReason: test.affectedReason,
    };
}
