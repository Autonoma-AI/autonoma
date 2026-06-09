import type { DiffsAgentInput, FlowInfo } from "@autonoma/diffs";
import { FlowIndex, scenarioRecipeDataSchema } from "@autonoma/diffs";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";

/** The DiffsAgent input minus the on-disk clone (rehydrated from codebase coords at run time). */
type DiffsAgentInputWithoutCodebase = Omit<DiffsAgentInput, "codebase">;

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

const mergeContextInfoSchema = z.object({
    prNumber: z.number(),
    sourceBranchName: z.string(),
    sourceSnapshotId: z.string(),
    mergeCommitSha: z.string(),
});

const preClassifiedConflictVersionSchema = z.object({
    role: z.enum(["target-current", "target-base", "source"]),
    sourceName: z.string().optional(),
    prNumber: z.number().optional(),
    assignmentId: z.string(),
    planId: z.string().nullable(),
});

const preClassifiedConflictInfoSchema = z.object({
    slug: z.string(),
    testName: z.string(),
    versions: z.array(preClassifiedConflictVersionSchema),
    involvedPrNumbers: z.array(z.number()),
});

/**
 * The frozen, on-disk shape of a captured Analysis case (`input.json`).
 *
 * It mirrors {@link DiffsAgentInput} with two substitutions per the eval-case
 * contract: the live `Codebase` becomes {@link CodebaseCoords}, and the
 * `FlowIndex` instance becomes its underlying array. Everything else is the
 * plain assembled agent input.
 */
export const analysisCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    headSha: z.string(),
    baseSha: z.string(),
    existingTests: z.array(existingTestInfoSchema),
    flowIndex: z.array(flowInfoSchema),
    merges: z.array(mergeContextInfoSchema).optional(),
    preClassifiedConflicts: z.array(preClassifiedConflictInfoSchema).optional(),
    testScopeGuidelines: z.string().optional(),
    scenarioRecipes: z.array(scenarioRecipeDataSchema).optional(),
});

export type AnalysisCaseInput = z.infer<typeof analysisCaseInputSchema>;

/** What rehydration yields: the git coordinates plus the agent input minus its codebase. */
export interface RehydratedAnalysisInput {
    coords: CodebaseCoords;
    agentInput: DiffsAgentInputWithoutCodebase;
}

/**
 * Reconstruct the agent input from a parsed case, rebuilding the `FlowIndex`
 * from its array form. The codebase itself is returned separately as coords for
 * the caller to rehydrate via `ensureCachedCheckout`.
 */
export function rehydrateAnalysisInput(parsed: AnalysisCaseInput): RehydratedAnalysisInput {
    const flows: FlowInfo[] = parsed.flowIndex;

    const agentInput: DiffsAgentInputWithoutCodebase = {
        headSha: parsed.headSha,
        baseSha: parsed.baseSha,
        existingTests: parsed.existingTests,
        flowIndex: new FlowIndex(flows),
        merges: parsed.merges ?? [],
        preClassifiedConflicts: parsed.preClassifiedConflicts ?? [],
        scenarioRecipes: parsed.scenarioRecipes ?? [],
    };

    if (parsed.testScopeGuidelines != null) {
        agentInput.testScopeGuidelines = parsed.testScopeGuidelines;
    }

    return { coords: parsed.codebase, agentInput };
}

/**
 * Freeze an assembled agent input into the on-disk case shape: replace the live
 * codebase with the given coords and the `FlowIndex` with its array. Validated
 * through the schema so capture can never write a malformed `input.json`.
 */
export function serializeAnalysisInput(
    coords: CodebaseCoords,
    agentInput: DiffsAgentInputWithoutCodebase,
): AnalysisCaseInput {
    return analysisCaseInputSchema.parse({
        codebase: coords,
        headSha: agentInput.headSha,
        baseSha: agentInput.baseSha,
        existingTests: agentInput.existingTests,
        flowIndex: agentInput.flowIndex.toArray(),
        merges: agentInput.merges ?? [],
        preClassifiedConflicts: agentInput.preClassifiedConflicts ?? [],
        testScopeGuidelines: agentInput.testScopeGuidelines,
        scenarioRecipes: agentInput.scenarioRecipes ?? [],
    });
}
