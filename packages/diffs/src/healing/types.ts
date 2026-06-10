import type { AffectedReason } from "@autonoma/db";
import type { GenerationVerdict, GenerationVerdictKind, ReplayVerdict, ReplayVerdictKind } from "@autonoma/types";
import type { ReviewLineage } from "../review/kernel";
import type { ScenarioData } from "../scenario-data";
import type { ScenarioIndex } from "../scenario-index";
import type { FlowSummary } from "./plan-authoring/types";

/**
 * One failing plan or run, summarised for the agent. Includes the reviewer's
 * verdict and reasoning so the agent can decide an action without having to
 * re-load the full review row.
 *
 * The `affectedReason` / `affectedReasoning` / `lineage` / `scenario` fields
 * are the unified diff-job context the `DiffJobContextLoader` gathers per
 * subject and the assembler merges in. Each is optional: a subject may not be a
 * flagged test, may be a first-iteration failure (no lineage), or may have run
 * without a scenario.
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
    /** `AffectedTest.affectedReason` - the category the diffs-agent flagged this test under. */
    affectedReason?: AffectedReason;
    /** `AffectedTest.reasoning` - the diffs-agent's explanation for flagging this test. */
    affectedReasoning?: string;
    /**
     * The complete per-test refinement-loop lineage: the plan rewrite history
     * and earlier iterations' verdicts, oldest first. Present only for
     * iteration-2+ failures; lets the agent see what it already tried and avoid
     * re-running strategies that already failed.
     */
    lineage?: ReviewLineage;
    /**
     * Materialized snapshot of the data the failing subject's scenario actually
     * seeded. Lets the agent tell a plan that references data the scenario never
     * created (rewrite to match the seed) from a real application bug.
     */
    scenario?: ScenarioData;
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
