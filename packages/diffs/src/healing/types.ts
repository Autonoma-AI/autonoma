import type { AffectedReason } from "@autonoma/db";
import type { GenerationVerdict, GenerationVerdictKind, ReplayVerdict, ReplayVerdictKind } from "@autonoma/types";
import type { IterationLineage, RenderableReviewStep } from "../review/kernel";
import type { ScenarioData } from "../scenario-data";
import type { ScenarioIndex } from "../scenario-index";
import type { HealingReviewLink } from "./actions";
import type { FlowSummary } from "./plan-authoring/types";

/**
 * One failing plan or run, summarised for the agent. Includes the reviewer's
 * verdict and reasoning so the agent can decide an action without having to
 * re-load the full review row.
 *
 * The `affectedReason` / `affectedReasoning` / `lineage` / `scenario` fields
 * are the unified diff-job context the `DiffJobContextLoader` gathers per
 * subject and the assembler merges in. `affectedReason`/`affectedReasoning` and
 * `scenario` are optional (a subject may not be a flagged test, or may have run
 * without a scenario); `lineage` is empty for a first-iteration failure.
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
     * Point-in-time refinement-loop history for this test, one entry per iteration
     * (the plan it scoped and the verdicts it reached), oldest first. Empty for
     * first-iteration failures; lets the agent see what it already tried and avoid
     * re-running strategies that already failed.
     */
    lineage: IterationLineage[];
    /**
     * Materialized snapshot of the data the failing subject's scenario actually
     * seeded. Lets the agent tell a plan that references data the scenario never
     * created (rewrite to match the seed) from a real application bug.
     */
    scenario?: ScenarioData;
    /**
     * The source review a `report_bug` / `report_engine_limitation` on this
     * failure links its evidence to - deterministic failure metadata the runner
     * stamps, not authored by the model. A failure surfaced at generation links
     * to its generation review, one surfaced at replay to its run review. Absent
     * when the failure carries no source review (e.g. the generation/run failed
     * before review); a failure with no review link cannot be the target of a
     * report action.
     */
    reviewLink?: HealingReviewLink;
    /**
     * The failing subject's executed steps (screenshot keys + step-output text),
     * gathered by the loader. The `fetch_step_evidence` tool resolves the
     * screenshot bytes for a step on demand so the agent can ground its bug report
     * in the actual evidence. Empty/absent when the subject persisted no steps.
     */
    steps?: RenderableReviewStep[];
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
