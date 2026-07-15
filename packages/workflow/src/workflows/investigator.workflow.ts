import type { AnalysisMode } from "@autonoma/types";
import { log } from "@temporalio/workflow";
import type { AnalysisCandidateFinding } from "../activities";

export interface InvestigatorWorkflowInput {
    /** The detached twin snapshot the pipeline operates on. */
    snapshotId: string;
    /** The test this Investigator owns. */
    slug: string;
    mode: AnalysisMode;
}

/**
 * Investigator (child workflow, one per test) - skeleton stub. The real Investigator will run the test on a
 * browser, classify the outcome with a self-heal loop, and emit a candidate finding; it writes only its own
 * `(snapshot, testCase)` rows and never files bugs. This stub only logs and returns a placeholder candidate so
 * the parent's fan-out is wired end-to-end.
 */
export async function investigatorWorkflow(input: InvestigatorWorkflowInput): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, mode } = input;
    log.info("Investigator workflow started (stub)", { snapshot: { snapshotId }, extra: { slug, mode } });

    const candidate: AnalysisCandidateFinding = {
        slug,
        category: "passed",
        headline: "Investigator stub - no analysis performed yet",
    };

    log.info("Investigator workflow finished (stub)", { snapshot: { snapshotId }, extra: { slug } });
    return candidate;
}
