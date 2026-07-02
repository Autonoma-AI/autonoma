import { logger as rootLogger } from "@autonoma/logger";
import { Output, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { withRetry } from "../retry";
import { REPAIR_RECIPE_AGENT_SYSTEM_PROMPT, buildRepairRecipePrompt } from "./repair-recipe-agent-prompt";
import type { RepairRecipeDeps, RepairRecipeInput } from "./repair-recipe-deps";
import { buildRepairRecipeTools } from "./repair-recipe-tools";
import type { ScenarioRepairRoute } from "./schema";
import { validateRecipeGraph } from "./validate-recipe-graph";

// Kept modest, and each leg retries at most twice, so the worst-case wall time stays inside the repair
// activity's startToCloseTimeout (the `investigationRepair` proxy) even when a leg times out and resends.
const INVESTIGATION_TIMEOUT_MS = 8 * 60_000;
const DECISION_TIMEOUT_MS = 3 * 60_000;
const MODEL_CALL_TRIES = 2;

/**
 * The agent's final decision. Every optional field is NULLABLE-and-required (OpenAI strict structured output
 * rejects a property missing from `required`); `toRecipeRepairResult` normalizes null -> undefined and drops
 * fields that don't belong to the chosen route.
 */
const RepairForModel = z.object({
    route: z.enum(["fix_test", "recipe_only", "recipe_and_sdk", "unknown"]),
    confidence: z.enum(["low", "medium", "high"]),
    reasoning: z.string(),
    /** recipe_only / recipe_and_sdk: the COMPLETE new create graph as a JSON string. */
    createGraphJson: z.string().nullable(),
    /** One sentence describing exactly what the recipe change does. */
    summary: z.string().nullable(),
    /** recipe_and_sdk: the client-factory limitation to fix, for their coding agent. */
    factoryIssue: z.string().nullable(),
    /** Give-up / recipe_and_sdk: a self-contained summary of what was tried + why it failed, for a human/agent. */
    handoff: z.string().nullable(),
});

/** The recipe-repair agent's result: a route, an optional VALIDATED candidate graph, and an optional handoff. */
export interface RecipeRepairResult {
    route: ScenarioRepairRoute;
    confidence: "low" | "medium" | "high";
    reasoning: string;
    /** Present + schema-valid iff the agent produced a usable recipe candidate. */
    createGraphJson?: string;
    summary?: string;
    factoryIssue?: string;
    handoff?: string;
}

/** Normalize the model output: null -> undefined, clear off-route fields, and drop a candidate that fails validation. */
export function toRecipeRepairResult(output: z.infer<typeof RepairForModel>): RecipeRepairResult {
    const wantsRecipe = output.route === "recipe_only" || output.route === "recipe_and_sdk";
    const factoryIssue = output.route === "recipe_and_sdk" ? (output.factoryIssue ?? undefined) : undefined;
    const handoff = output.handoff ?? undefined;

    const base = {
        route: output.route,
        confidence: output.confidence,
        reasoning: output.reasoning,
        factoryIssue,
        handoff,
    };

    if (!wantsRecipe) return base;

    const candidate = output.createGraphJson ?? undefined;
    if (candidate == null) return base;

    // Never return a candidate that fails local validation - fall back to a handoff so nothing broken is staged.
    const validation = validateRecipeGraph(candidate);
    if (!validation.valid) {
        const why = `agent's final candidate failed validation: ${validation.errors.join("; ")}`;
        return { ...base, handoff: handoff != null ? `${handoff} (${why})` : why };
    }

    return { ...base, createGraphJson: candidate, summary: output.summary ?? undefined };
}

/**
 * Repair a scenario recipe with a tool-using agent: it reads the client's factory code + DB schema, queries the
 * live backend to see what data already exists, validates candidate graphs locally, and dry-run-seeds them against
 * the real factory before committing - iterating until it has a factory-accepted graph or decides the fix belongs
 * elsewhere (the test is wrong / the factory needs a code change). Analysis + dry-runs only; it never writes a
 * recipe (the caller stages the returned candidate on the twin and validates it there). Throws only on a hard
 * model failure; the caller contains it and reports no repair.
 */
export async function repairRecipeWithAgent(
    input: RepairRecipeInput,
    deps: RepairRecipeDeps,
): Promise<RecipeRepairResult> {
    const logger = rootLogger.child({
        name: "repairRecipeWithAgent",
        extra: { appSlug: input.appSlug, prNumber: input.prNumber, slug: input.slug },
    });
    logger.info("Repairing scenario recipe with the agent", { extra: { dryRun: deps.dryRunSeed != null } });

    const tools = buildRepairRecipeTools(deps);
    const investigation = await withRetry(
        () =>
            generateText({
                model: deps.model,
                system: REPAIR_RECIPE_AGENT_SYSTEM_PROMPT,
                tools,
                stopWhen: stepCountIs(deps.maxSteps),
                prompt: buildRepairRecipePrompt(input),
                abortSignal: AbortSignal.timeout(INVESTIGATION_TIMEOUT_MS),
            }),
        { label: "recipe-repair-investigation", tries: MODEL_CALL_TRIES },
    );

    const decision = await withRetry(
        () =>
            generateText({
                model: deps.model,
                system: REPAIR_RECIPE_AGENT_SYSTEM_PROMPT,
                output: Output.object({ schema: RepairForModel }),
                prompt: [
                    "Based on your investigation below, give your final decision.",
                    "If you produce a create graph, it MUST be the one you validated (schema-valid and, where dry_run_seed was available, factory-accepted).",
                    "",
                    "--- your investigation ---",
                    investigation.text,
                ].join("\n"),
                abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
            }),
        { label: "recipe-repair-decision", tries: MODEL_CALL_TRIES },
    );

    const result = await confirmWithDryRun(toRecipeRepairResult(decision.output), deps.dryRunSeed, logger);
    logger.info("Recipe repair decided", {
        extra: { route: result.route, confidence: result.confidence, hasCandidate: result.createGraphJson != null },
    });
    return result;
}

/**
 * The structured decision re-emits the candidate from memory (that model call has no tools), so a graph the model
 * subtly changed while re-writing it would pass only the cheap local `validateRecipeGraph`, never the factory. When
 * dry_run_seed is available, re-seed the FINAL candidate against the real factory before returning it - the twin
 * rerun is authoritative but expensive, and this catches a factory-rejected graph for the price of one provision.
 * On failure the candidate is dropped to a handoff so nothing the factory rejects is ever staged. A no-op when
 * dry_run_seed is unwired or the result has no recipe candidate.
 */
async function confirmWithDryRun(
    result: RecipeRepairResult,
    dryRunSeed: RepairRecipeDeps["dryRunSeed"],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<RecipeRepairResult> {
    const candidate = result.createGraphJson;
    if (candidate == null || dryRunSeed == null) return result;

    const seed = await dryRunSeed(candidate).catch((error) => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
    }));
    if (seed.ok) return result;

    logger.warn("Final candidate failed the confirming dry-run; dropping it to a handoff", {
        extra: { detail: seed.detail },
    });
    const why = `final candidate was rejected by the factory on a confirming dry-run: ${seed.detail}`;
    // Drop the candidate (and its summary) so nothing factory-rejected is staged; keep the route + factoryIssue.
    return {
        route: result.route,
        confidence: result.confidence,
        reasoning: result.reasoning,
        factoryIssue: result.factoryIssue,
        handoff: result.handoff != null ? `${result.handoff} (${why})` : why,
    };
}
