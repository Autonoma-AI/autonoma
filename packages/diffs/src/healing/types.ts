import type { GenerationVerdict, GenerationVerdictKind, ReplayVerdict, ReplayVerdictKind } from "@autonoma/types";
import type { ScenarioIndex } from "../scenario-index";
import type { FlowSummary } from "./plan-authoring/types";

/**
 * One failing plan or run, summarised for the agent. Includes the reviewer's
 * verdict and reasoning so the agent can decide an action without having to
 * re-load the full review row.
 */
export interface FailureRecord {
    /** Unique key the agent uses to refer to this failure (typically planId or runId). */
    key: string;
    source: "generation" | "replay";
    testCaseId: string;
    testCaseSlug: string;
    testCaseName: string;
    planId: string;
    /** The plan prompt that produced this failure. */
    planPrompt: string;
    /** Reviewer's verdict, when one was produced. */
    verdict?: GenerationVerdict | ReplayVerdict;
    verdictKind?: GenerationVerdictKind | ReplayVerdictKind;
    /** Whichever id (generationId / runId) is the source's primary key. */
    sourceId: string;
    sourceStatus: string;
    /** Reviewer's free-text reasoning. */
    reviewReasoning?: string;
}

export interface SnapshotInfo {
    snapshotId: string;
    applicationId: string;
    organizationId: string;
}

export interface PlanAuthoringInput {
    scenarios: ScenarioIndex;
    flows: FlowSummary[];
    /** Free-text guidelines from the application owner about what to / not to test. */
    testScopeGuidelines?: string;
}
