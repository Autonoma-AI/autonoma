import type { AnalysisRunOutcome } from "@autonoma/types";

/** GitHub operations that follow a settled authoritative analysis run. */
export interface AnalysisGitHub {
    conclude(outcome: AnalysisRunOutcome): Promise<void>;
    /** The unified PR comment renders both a succeeded run (full body) and a failed one (could-not-complete). */
    comment(outcome: AnalysisRunOutcome): Promise<void>;
}
