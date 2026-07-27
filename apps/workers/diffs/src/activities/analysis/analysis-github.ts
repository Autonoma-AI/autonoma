import type { AnalysisRunOutcome } from "@autonoma/types";

/** GitHub operations that follow a settled authoritative analysis run. */
export interface AnalysisGitHub {
    conclude(outcome: AnalysisRunOutcome): Promise<void>;
    comment(outcome: Extract<AnalysisRunOutcome, { kind: "succeeded" }>): Promise<void>;
}
