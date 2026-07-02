import { z } from "zod";

/**
 * One reconciliation decision for a single branch edit. `apply` carries the edit into main's suite (using
 * `mergedPlan` if the agent had to adapt it to main's current state, else the branch's proposed plan);
 * `skip` drops it (already covered, superseded, or in conflict) with the reason recorded for the report.
 */
export interface MergeDecision {
    /** The kind of branch edit this decision resolves. */
    kind: "new_test" | "modification";
    /** The existing test's slug (modification) or the proposed test's name (new_test) - matches the input edit. */
    ref: string;
    action: "apply" | "skip";
    /** Why this action - self-contained, so the report reads without cross-referencing. */
    reason: string;
    /**
     * The final plan to write when `action` is `apply`, set only when the branch's proposed plan had to be
     * ADAPTED to main's current state (a conflicting change others merged). Absent to apply the proposed plan
     * verbatim, and always absent for `skip`.
     */
    mergedPlan?: string;
}

/**
 * One reconciliation decision for a single branch RECIPE edit. `apply` carries the branch's `create` graph into
 * main's recipe (using `mergedCreateGraph` if it had to be adapted to main's current recipe, else the branch's
 * proposed graph verbatim); `skip` drops it (main already has the data, or main's recipe conflicts) with a reason.
 */
export interface RecipeMergeDecision {
    /** The scenario whose recipe this decision resolves - matches the input recipe edit. */
    scenarioId: string;
    action: "apply" | "skip";
    /** Why this action - self-contained, so the report reads without cross-referencing. */
    reason: string;
    /**
     * The final `create` graph (JSON string) to write when `action` is `apply`, set only when the branch's
     * proposed graph had to be ADAPTED to main's current recipe. Absent to apply the proposed graph verbatim,
     * and always absent for `skip`.
     */
    mergedCreateGraph?: string;
}

/** The reconciler's output: one decision per branch edit + one per recipe edit, in the order presented. */
export interface MergePlan {
    decisions: MergeDecision[];
    recipeDecisions: RecipeMergeDecision[];
}

/**
 * The schema the MODEL produces. `mergedPlan` is NULLABLE-and-required rather than optional because OpenAI's
 * strict structured-output mode requires every property to appear in `required` (an optional key is rejected).
 * `toMergePlan` normalizes the null back to `undefined` for the public shape.
 */
export const MergePlanForModel = z.object({
    decisions: z.array(
        z.object({
            kind: z.enum(["new_test", "modification"]),
            ref: z.string(),
            action: z.enum(["apply", "skip"]),
            reason: z.string(),
            mergedPlan: z.string().nullable(),
        }),
    ),
});

/** The schema the MODEL produces for the recipe reconcile pass. Same nullable-required convention as MergePlanForModel. */
export const RecipeMergePlanForModel = z.object({
    recipeDecisions: z.array(
        z.object({
            scenarioId: z.string(),
            action: z.enum(["apply", "skip"]),
            reason: z.string(),
            mergedCreateGraph: z.string().nullable(),
        }),
    ),
});

/** Normalize the test-edit model output (nullable mergedPlan) into the decisions half of a MergePlan. */
export function toMergeDecisions(output: z.infer<typeof MergePlanForModel>): MergeDecision[] {
    return output.decisions.map((decision) => ({
        kind: decision.kind,
        ref: decision.ref,
        action: decision.action,
        reason: decision.reason,
        mergedPlan: decision.mergedPlan ?? undefined,
    }));
}

/** Normalize the recipe model output (nullable mergedCreateGraph) into the recipeDecisions half of a MergePlan. */
export function toRecipeMergeDecisions(output: z.infer<typeof RecipeMergePlanForModel>): RecipeMergeDecision[] {
    return output.recipeDecisions.map((decision) => ({
        scenarioId: decision.scenarioId,
        action: decision.action,
        reason: decision.reason,
        mergedCreateGraph: decision.mergedCreateGraph ?? undefined,
    }));
}
