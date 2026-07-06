import { RunReviewVerdict } from "@autonoma/db";
import {
    type ExistingTestInfo,
    type FlowInfo,
    FlowIndex,
    type FlowSummary,
    type HealingInput as LiveHealingInput,
    ScenarioIndex,
    type ScenarioInfo,
    affectedReasonSchema,
    healingActionSchema,
    scenarioDataSchema,
} from "@autonoma/diffs";
import {
    generationVerdictKindSchema,
    generationVerdictSchema,
    healingReviewLinkSchema,
    replayVerdictKindSchema,
    replayVerdictSchema,
} from "@autonoma/types";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";

/**
 * The HealingAgent input minus the runner-supplied runtime handles: the on-disk
 * clone (rehydrated from codebase coords at run time) and the screenshot loader
 * (evals run without one, so `fetch_step_evidence` degrades to step-output text).
 */
type HealingInputWithoutCodebase = Omit<LiveHealingInput, "codebase" | "screenshotLoader">;

/**
 * The per-test refinement history frozen alongside a failure, one entry per
 * iteration. Mirrors the reviewer fixtures' lineage shape (`@autonoma/diffs`
 * `IterationLineage`); empty for first-iteration failures and failures outside a
 * loop.
 */
const iterationLineageSchema = z.array(
    z.object({
        iterationNumber: z.number().int().positive(),
        prompt: z.string(),
        healingReasoning: z.string().optional(),
        verdicts: z.array(z.object({ verdict: z.enum(RunReviewVerdict), reasoning: z.string() })),
    }),
);

/**
 * A subject's executed step, frozen alongside its failure (mirrors
 * `@autonoma/diffs` `RenderableReviewStep`). Screenshot keys + step-output text
 * only; the bytes are rehydrated at run time. Defaulted to `[]` so a fixture
 * frozen before step evidence was captured still rehydrates.
 */
const renderableReviewStepSchema = z.object({
    order: z.number().int().nonnegative(),
    interaction: z.string(),
    params: z.unknown(),
    status: z.enum(["success", "failed"]),
    output: z.unknown().optional(),
    error: z.string().optional(),
    errorName: z.string().optional(),
    screenshotBeforeKey: z.string().optional(),
    screenshotAfterKey: z.string().optional(),
});

const failureRecordSchema = z.object({
    key: z.string(),
    source: z.enum(["generation", "replay"]),
    testCaseId: z.string(),
    testCaseSlug: z.string(),
    testCaseName: z.string(),
    planId: z.string(),
    planPrompt: z.string(),
    verdict: z.union([generationVerdictSchema, replayVerdictSchema]).optional(),
    verdictKind: z.union([generationVerdictKindSchema, replayVerdictKindSchema]).optional(),
    sourceId: z.string(),
    sourceStatus: z.string(),
    reviewReasoning: z.string().optional(),
    // The unified diff-job context the loader gathers per failure.
    affectedReason: affectedReasonSchema.optional(),
    affectedReasoning: z.string().optional(),
    lineage: iterationLineageSchema.default([]),
    scenario: scenarioDataSchema.optional(),
    steps: z.array(renderableReviewStepSchema).default([]),
    // Deterministic source-review link a report action attaches evidence to.
    reviewLink: healingReviewLinkSchema.optional(),
});

const existingTestInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    prompt: z.string(),
});

const flowInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    testSlugs: z.array(z.string()),
});

const scenarioRecipeSchema = z.object({
    fingerprint: z.string(),
    fixtureJson: z.unknown(),
    validationStatus: z.string(),
});

const scenarioInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    activeRecipe: scenarioRecipeSchema.optional(),
    sampleMetadata: z.unknown().optional(),
});

const flowSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    testCount: z.number().int().nonnegative(),
});

const planAuthoringSchema = z.object({
    scenarios: z.array(scenarioInfoSchema),
    flows: z.array(flowSummarySchema),
    testScopeGuidelines: z.string().optional(),
});

/**
 * The frozen, on-disk shape of a captured Healing case (`input.json`).
 *
 * Mirrors {@link LiveHealingInput} with three substitutions per the eval-case
 * contract: the live `Codebase` becomes {@link CodebaseCoords}, and both the
 * `FlowIndex` and `ScenarioIndex` instances become their underlying arrays.
 *
 * `change` (the snapshot's base/head SHAs) and `analysisReasoning` are the
 * snapshot-level diff-job context, both required - healing runs against a
 * checked-out head SHA, downstream of a successful analysis. `analysisReasoning`
 * is defaulted so a fixture frozen before it was captured still rehydrates.
 * `existingTests` and `flowIndex` are defaulted for the same reason (fixtures
 * frozen before those capabilities folded in).
 */
export const healingCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    iteration: z.number().int().positive(),
    // The loop's iteration cap; the agent withholds its retry tool when
    // `iteration === maxIterations`. Defaulted to the cap both flows now use (3)
    // so a fixture frozen before this field was captured still rehydrates with
    // production-faithful final-turn behavior.
    maxIterations: z.number().int().positive().default(3),
    snapshotId: z.string(),
    applicationId: z.string(),
    organizationId: z.string(),
    priorActions: z.array(healingActionSchema),
    failures: z.array(failureRecordSchema),
    existingTests: z.array(existingTestInfoSchema).default([]),
    flowIndex: z.array(flowInfoSchema).default([]),
    planAuthoring: planAuthoringSchema,
    change: z.object({ baseSha: z.string(), headSha: z.string() }),
    // Defaulted so a fixture frozen before analysis reasoning was captured still
    // rehydrates.
    analysisReasoning: z.string().default(""),
});

export type HealingCaseInput = z.infer<typeof healingCaseInputSchema>;

/** What rehydration yields: the git coordinates plus the agent input minus its codebase. */
export interface RehydratedHealingInput {
    coords: CodebaseCoords;
    agentInput: HealingInputWithoutCodebase;
}

/**
 * Reconstruct the agent input from a parsed case, rebuilding the `FlowIndex`
 * and `ScenarioIndex` instances from their array forms. The codebase itself is
 * returned separately as coords for the caller to rehydrate via
 * `ensureCachedCheckout`.
 */
export function rehydrateHealingInput(parsed: HealingCaseInput): RehydratedHealingInput {
    const scenarios: ScenarioInfo[] = parsed.planAuthoring.scenarios;
    const flowSummaries: FlowSummary[] = parsed.planAuthoring.flows;
    const flows: FlowInfo[] = parsed.flowIndex;
    const existingTests: ExistingTestInfo[] = parsed.existingTests;

    const agentInput: HealingInputWithoutCodebase = {
        iteration: parsed.iteration,
        maxIterations: parsed.maxIterations,
        snapshotId: parsed.snapshotId,
        applicationId: parsed.applicationId,
        organizationId: parsed.organizationId,
        priorActions: parsed.priorActions,
        failures: parsed.failures,
        flowIndex: new FlowIndex(flows),
        existingTests,
        planAuthoring: {
            scenarios: new ScenarioIndex(scenarios),
            flows: flowSummaries,
            testScopeGuidelines: parsed.planAuthoring.testScopeGuidelines,
        },
        change: parsed.change,
        analysisReasoning: parsed.analysisReasoning,
    };

    return { coords: parsed.codebase, agentInput };
}

/**
 * Freeze an assembled agent input into the on-disk case shape: replace the
 * live codebase with the given coords and the `FlowIndex` / `ScenarioIndex`
 * with their arrays. Validated through the schema so capture can never write a
 * malformed `input.json`.
 */
export function serializeHealingInput(
    coords: CodebaseCoords,
    agentInput: HealingInputWithoutCodebase,
    scenarios: ScenarioInfo[],
): HealingCaseInput {
    return healingCaseInputSchema.parse({
        codebase: coords,
        iteration: agentInput.iteration,
        maxIterations: agentInput.maxIterations,
        snapshotId: agentInput.snapshotId,
        applicationId: agentInput.applicationId,
        organizationId: agentInput.organizationId,
        priorActions: agentInput.priorActions,
        failures: agentInput.failures,
        existingTests: agentInput.existingTests,
        flowIndex: agentInput.flowIndex.toArray(),
        planAuthoring: {
            scenarios,
            flows: agentInput.planAuthoring.flows,
            testScopeGuidelines: agentInput.planAuthoring.testScopeGuidelines,
        },
        change: agentInput.change,
        analysisReasoning: agentInput.analysisReasoning,
    });
}
