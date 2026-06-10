import type { FlowInfo, ResolutionAgentInput, ScenarioInfo } from "@autonoma/diffs";
import { FlowIndex, ScenarioIndex, affectedReasonSchema, scenarioDataSchema } from "@autonoma/diffs";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";

/** The ResolutionAgent input minus the on-disk clone (rehydrated from codebase coords at run time). */
type ResolutionAgentInputWithoutCodebase = Omit<ResolutionAgentInput, "codebase">;

const quarantineInfoSchema = z.object({
    reason: z.enum(["application_bug", "engine_limitation"]),
    bugId: z.string().optional(),
    issueId: z.string().optional(),
});

const existingTestInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    prompt: z.string(),
    quarantine: quarantineInfoSchema.optional(),
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

const runReviewVerdictSchema = z.object({
    runId: z.string(),
    testSlug: z.string(),
    testName: z.string(),
    originalPrompt: z.string(),
    runStatus: z.string(),
    verdict: z.string(),
    reviewReasoning: z.string(),
    issueTitle: z.string().optional(),
    issueDescription: z.string().optional(),
    affectedReason: affectedReasonSchema.optional(),
    // Optional so corpus fixtures captured before per-run scenario data still
    // rehydrate; capture freezes it whenever the run had a resolved scenario.
    scenario: scenarioDataSchema.optional(),
});

const testCandidateInputSchema = z.object({
    candidateId: z.string(),
    name: z.string(),
    instruction: z.string(),
    reasoning: z.string(),
});

/**
 * The frozen, on-disk shape of a captured Resolution case (`input.json`).
 *
 * It mirrors {@link ResolutionAgentInput} with three substitutions per the
 * eval-case contract: the live `Codebase` becomes {@link CodebaseCoords}, and
 * both the `FlowIndex` and `ScenarioIndex` instances become their underlying
 * arrays. Everything else is the plain assembled agent input.
 */
export const resolutionCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    existingTests: z.array(existingTestInfoSchema),
    flowIndex: z.array(flowInfoSchema),
    scenarioIndex: z.array(scenarioInfoSchema),
    verdicts: z.array(runReviewVerdictSchema),
    step1Reasoning: z.string(),
    testCandidates: z.array(testCandidateInputSchema),
    testScopeGuidelines: z.string().optional(),
});

export type ResolutionCaseInput = z.infer<typeof resolutionCaseInputSchema>;

/** What rehydration yields: the git coordinates plus the agent input minus its codebase. */
export interface RehydratedResolutionInput {
    coords: CodebaseCoords;
    agentInput: ResolutionAgentInputWithoutCodebase;
}

/**
 * Reconstruct the agent input from a parsed case, rebuilding the `FlowIndex`
 * and `ScenarioIndex` from their array forms. The codebase itself is returned
 * separately as coords for the caller to rehydrate via `ensureCachedCheckout`.
 */
export function rehydrateResolutionInput(parsed: ResolutionCaseInput): RehydratedResolutionInput {
    const flows: FlowInfo[] = parsed.flowIndex;
    const scenarios: ScenarioInfo[] = parsed.scenarioIndex;

    const agentInput: ResolutionAgentInputWithoutCodebase = {
        flowIndex: new FlowIndex(flows),
        scenarioIndex: new ScenarioIndex(scenarios),
        existingTests: parsed.existingTests,
        verdicts: parsed.verdicts,
        step1Reasoning: parsed.step1Reasoning,
        testCandidates: parsed.testCandidates,
    };

    if (parsed.testScopeGuidelines != null) {
        agentInput.testScopeGuidelines = parsed.testScopeGuidelines;
    }

    return { coords: parsed.codebase, agentInput };
}

/**
 * Freeze an assembled agent input into the on-disk case shape: replace the live
 * codebase with the given coords and the `FlowIndex` / `ScenarioIndex` with
 * their arrays. Validated through the schema so capture can never write a
 * malformed `input.json`.
 */
export function serializeResolutionInput(
    coords: CodebaseCoords,
    agentInput: ResolutionAgentInputWithoutCodebase,
): ResolutionCaseInput {
    return resolutionCaseInputSchema.parse({
        codebase: coords,
        existingTests: agentInput.existingTests,
        flowIndex: agentInput.flowIndex.toArray(),
        scenarioIndex: agentInput.scenarioIndex.toArray(),
        verdicts: agentInput.verdicts,
        step1Reasoning: agentInput.step1Reasoning,
        testCandidates: agentInput.testCandidates,
        testScopeGuidelines: agentInput.testScopeGuidelines,
    });
}
