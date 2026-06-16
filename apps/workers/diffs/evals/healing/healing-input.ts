import { RunReviewVerdict } from "@autonoma/db";
import {
    type FlowSummary,
    type HealingReviewLink,
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

/** The HealingAgent input minus the on-disk clone (rehydrated from codebase coords at run time). */
type HealingInputWithoutCodebase = Omit<LiveHealingInput, "codebase">;

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
 * Mirrors {@link LiveHealingInput} with two substitutions per the eval-case
 * contract: the live `Codebase` becomes {@link CodebaseCoords}, and the
 * `ScenarioIndex` instance becomes its underlying array. `reportableReviewLinks`
 * is stored as `[testCaseId, link][]` tuples (a `Map` is not JSON-native).
 *
 * `change` (the snapshot's base/head SHAs) and `analysisReasoning` are the
 * snapshot-level diff-job context, both required - healing runs against a
 * checked-out head SHA, downstream of a successful analysis. `analysisReasoning`
 * is defaulted so a fixture frozen before it was captured still rehydrates.
 */
export const healingCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    iteration: z.number().int().positive(),
    snapshotId: z.string(),
    applicationId: z.string(),
    organizationId: z.string(),
    priorActions: z.array(healingActionSchema),
    failures: z.array(failureRecordSchema),
    reportableReviewLinks: z.array(z.tuple([z.string(), healingReviewLinkSchema])),
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
 * Reconstruct the agent input from a parsed case, rebuilding the
 * `ScenarioIndex` instance from its array form and the `reportableReviewLinks`
 * `Map` from its entry tuples. The codebase itself is returned separately as
 * coords for the caller to rehydrate via `ensureCachedCheckout`.
 */
export function rehydrateHealingInput(parsed: HealingCaseInput): RehydratedHealingInput {
    const scenarios: ScenarioInfo[] = parsed.planAuthoring.scenarios;
    const flows: FlowSummary[] = parsed.planAuthoring.flows;

    const agentInput: HealingInputWithoutCodebase = {
        iteration: parsed.iteration,
        snapshotId: parsed.snapshotId,
        applicationId: parsed.applicationId,
        organizationId: parsed.organizationId,
        priorActions: parsed.priorActions,
        failures: parsed.failures,
        reportableReviewLinks: new Map<string, HealingReviewLink>(parsed.reportableReviewLinks),
        planAuthoring: {
            scenarios: new ScenarioIndex(scenarios),
            flows,
            testScopeGuidelines: parsed.planAuthoring.testScopeGuidelines,
        },
        change: parsed.change,
        analysisReasoning: parsed.analysisReasoning,
    };

    return { coords: parsed.codebase, agentInput };
}

/**
 * Freeze an assembled agent input into the on-disk case shape: replace the
 * live codebase with the given coords, the `ScenarioIndex` with its array, and
 * the `reportableReviewLinks` `Map` with its entry tuples. Validated through
 * the schema so capture can never write a malformed `input.json`.
 */
export function serializeHealingInput(
    coords: CodebaseCoords,
    agentInput: HealingInputWithoutCodebase,
    scenarios: ScenarioInfo[],
): HealingCaseInput {
    return healingCaseInputSchema.parse({
        codebase: coords,
        iteration: agentInput.iteration,
        snapshotId: agentInput.snapshotId,
        applicationId: agentInput.applicationId,
        organizationId: agentInput.organizationId,
        priorActions: agentInput.priorActions,
        failures: agentInput.failures,
        reportableReviewLinks: Array.from(agentInput.reportableReviewLinks.entries()),
        planAuthoring: {
            scenarios,
            flows: agentInput.planAuthoring.flows,
            testScopeGuidelines: agentInput.planAuthoring.testScopeGuidelines,
        },
        change: agentInput.change,
        analysisReasoning: agentInput.analysisReasoning,
    });
}
