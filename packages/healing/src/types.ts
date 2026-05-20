import type { Codebase } from "@autonoma/codebase";
import type { GenerationVerdict, GenerationVerdictKind, ReplayVerdict, ReplayVerdictKind } from "@autonoma/types";
import type { ModelMessage } from "ai";
import type { HealingAction } from "./actions";
import type { FlowSummary, ScenarioLookup } from "./plan-authoring/types";

export type { HealingAction } from "./actions";

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

export interface DiffsContext {
    baseSha: string;
    /** Codebase clone is checked out at this SHA. */
    headSha: string;
    /** Files that changed between baseSha and headSha. Cheap to inline at prompt time. */
    changedFiles: string[];
    /** Step-1 diffs analysis narrative. */
    step1Reasoning: string;
    /** New test ideas the analysis agent suggested. */
    testCandidates: TestCandidateInput[];
}

export interface TestCandidateInput {
    name: string;
    folderId: string;
    folderName: string;
    instruction: string;
    reasoning: string;
}

export interface SnapshotInfo {
    snapshotId: string;
    applicationId: string;
    organizationId: string;
}

export interface PlanAuthoringInput {
    scenarios: ScenarioLookup;
    flows: FlowSummary[];
    /** Free-text guidelines from the application owner about what to / not to test. */
    testScopeGuidelines?: string;
}

export type HealingInput =
    | (SnapshotInfo & {
          mode: "diffs";
          failures: FailureRecord[];
          diffContext: DiffsContext;
          codebase: Codebase;
          planAuthoring: PlanAuthoringInput;
      })
    | (SnapshotInfo & {
          mode: "refinement";
          iteration: number;
          /** Actions emitted in earlier iterations of the same loop. */
          priorActions: HealingAction[];
          failures: FailureRecord[];
          codebase: Codebase;
          planAuthoring: PlanAuthoringInput;
      });

export interface HealingResult {
    actions: HealingAction[];
    reasoning: string;
    /** Full LLM conversation produced by the agent. Captured so it can be persisted for debugging. */
    conversation: ModelMessage[];
}
