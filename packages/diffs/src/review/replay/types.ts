import type { ApplicationArchitecture } from "@autonoma/db";
import type { OverlayPoint } from "@autonoma/types";
import type { ScenarioData } from "../../scenario-data";
import type { ChangeContext, ReviewLineage, ReviewStep } from "../kernel";

/**
 * One reviewed replay step: the normalized {@link ReviewStep} plus the
 * presentation metadata the shared renderer and screenshot tool need (the
 * step's `order` and its before/after screenshot keys). The replay run persists
 * every step into a single `output` JSON blob with no status column, so the
 * loader derives `status`/`error`/`errorName` from that blob: a successful step
 * carries the command's structured `output`, while a failed step carries the
 * `errorName` + message the persister recorded.
 */
export interface RunStepData extends ReviewStep {
    order: number;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
    /** The engine's resolved click/drag point(s), extracted from `output` for screenshot annotation. */
    overlayPoints?: OverlayPoint[];
}

export interface RunContext {
    runId: string;
    organizationId: string;
    testPlanPrompt: string;
    testCaseName: string;
    steps: RunStepData[];
    videoS3Key?: string;
    finalScreenshotKey?: string;
    /** Gates before-screenshot point annotation to WEB. */
    architecture?: ApplicationArchitecture;
    /**
     * DB-sourced facts about the code change under review. Optional so legacy
     * fixtures captured before change context existed still rehydrate; production
     * always populates it via `DiffJobContextLoader`.
     */
    change?: ChangeContext;
    /**
     * Point-in-time refinement-loop lineage for this test: the prior verdicts and
     * the plan rewrite history. Absent for first-iteration reviews (no earlier
     * iterations) and for legacy fixtures captured before lineage existed.
     */
    lineage?: ReviewLineage;
    /**
     * Materialized snapshot of the data the run's scenario actually created.
     * Omitted when the run has no scenario instance, UP never succeeded, or the
     * generated-data graph is empty (e.g. historical instances predating #815).
     * A bounded summary is inlined into the prompt; full records are surfaced
     * on demand via the `read_scenario_entities` tool.
     */
    scenario?: ScenarioData;
}
