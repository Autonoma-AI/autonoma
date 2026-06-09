import type { ScenarioData } from "../../scenario-data";
import type { ChangeContext, ReviewLineage } from "../kernel";

export interface RunStepData {
    order: number;
    interaction: string;
    params: unknown;
    output: unknown;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
}

export interface RunContext {
    runId: string;
    organizationId: string;
    testPlanPrompt: string;
    testCaseName: string;
    steps: RunStepData[];
    videoS3Key?: string;
    finalScreenshotKey?: string;
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
