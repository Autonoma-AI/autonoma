import { type LanguageModel, Output, generateText } from "ai";
import { z } from "zod";
import { formatException } from "../../../core/errors";
import { AI_MAX_RETRIES } from "../../../core/model";

/**
 * Which side of the test a failure originates from.
 *
 * - `recipe`         - the test DATA we sent is wrong (a _ref points at a
 *                      non-existent alias, a bad field value, a missing/extra
 *                      field, a type mismatch). Regenerating the data can fix it,
 *                      so autofix is worth running.
 * - `implementation` - the developer's HANDLER code is wrong (an unregistered
 *                      factory, a bug in their insert/delete logic, a wrong
 *                      column/table name, a server crash). No amount of data
 *                      regeneration fixes this - the user must change code.
 * - `unclear`        - not confidently attributable to either side.
 */
export type FailureSide = "recipe" | "implementation" | "unclear";

/** Which leg of the test failed: UP (create test data) or DOWN (tear it down). */
export type FailurePhase = "create" | "teardown";

export interface FailureClassification {
    side: FailureSide;
    /** One plain-language sentence the user sees explaining the verdict. */
    reason: string;
}

const classificationSchema = z.object({
    side: z
        .enum(["recipe", "implementation", "unclear"])
        .describe(
            "recipe = the test data we sent is wrong and regenerating it could fix the failure; " +
                "implementation = the developer's handler/factory code is wrong and only a code change fixes it; " +
                "unclear = cannot confidently attribute the failure to either side.",
        ),
    reason: z
        .string()
        .describe("One short, plain-language sentence explaining the verdict for the user. No code, no jargon dumps."),
});

export interface ClassifyArgs {
    entityName: string;
    /** UP (create) or DOWN (teardown) - teardown failures skew strongly implementation-side. */
    phase: FailurePhase;
    /** HTTP status of the failed response, when the request got one (5xx skews implementation-side). */
    httpStatus?: number;
    /** The raw server error body or formatted exception string. */
    error: unknown;
    /** The recipe payload that was sent (so the model can judge whether different data would help). */
    recipe: unknown;
    /** The _alias values declared by already-created parent entities - the ONLY valid _ref targets. */
    validRefAliases?: string;
    /** What the entity audit recorded about how this entity is created (factory existence, owners). */
    entityAudit?: string;
    /** The live field schema for this entity from the SDK /discover endpoint, if
     *  available - the source of truth for required fields and types. */
    liveSchema?: string;
}

/**
 * A primer on the system under test. Without this the model has no idea what an
 * "Environment Factory", a recipe, a _ref, or an UP/DOWN request even is, and
 * can't reason about which side of the contract broke.
 */
const PRIMER = `## Background - what you are looking at

The Autonoma SDK lets a developer seed and tear down test data through a single HTTP endpoint on their own backend (the "Environment Factory"). For each database entity the developer registers a *factory* with two functions: a create() that inserts records, and a teardown() that deletes them. Their handler code calls into their app's real service/ORM layer.

A separate tool (not the developer) generates the *recipe*: JSON test data, one array of records per entity. Each record may carry an "_alias" (a unique handle, e.g. "account_1") and "_ref" fields ({ "_ref": "account_1" }) that point at an alias declared by an already-created parent entity. The tool sends this recipe to the endpoint:
- An **UP** request asks the factory to create the records (calls create()).
- A **DOWN** request asks the factory to tear them down (calls teardown()).

So a failure has exactly two possible origins, and your only job is to tell them apart:`;

export function buildClassifierPrompt(args: ClassifyArgs): string {
    const errorText = typeof args.error === "string" ? args.error : JSON.stringify(args.error, null, 2);
    const phaseLine =
        args.phase === "teardown"
            ? `This was a DOWN (teardown) request. Teardown runs the developer's delete logic against data the create() step already accepted, so teardown failures are usually implementation-side (wrong delete order, foreign-key cleanup bugs) rather than caused by the recipe.`
            : `This was an UP (create) request - the factory tried to insert the recipe records.`;
    const statusLine =
        args.httpStatus != null
            ? `HTTP status: ${args.httpStatus}. (A 5xx usually means the handler threw; a 4xx is more often a rejected payload, but use the error text - status alone is not decisive.)`
            : `No HTTP status (the request threw before a response - often a network/server-process problem, lean implementation or unclear).`;

    return `${PRIMER}

- RECIPE DATA is wrong - the JSON the tool sent doesn't fit the developer's (correct) schema. Examples of the *kind* of problem (not an exhaustive list): the request body references an alias (_ref) that no record in THIS SAME request declares with an _alias, a field holds a value the backend rejects, a required field is missing or an unknown field was sent, or a value has the wrong type. These are fixable by regenerating the data - the developer's code is fine. NOTE: an error like "references unknown alias(es): X" is recipe-side whenever X is not declared by an _alias in the test data shown below - the SDK resolves _refs WITHIN the request body, so it does not matter whether X appears in the "valid targets" list (that list is historical context about other entities' own runs, NOT the contents of this request).
- IMPLEMENTATION is wrong - the developer's own handler/factory code is broken. Examples of the *kind* of problem: the factory for this entity is not registered, the handler references a column or table that does not exist (even though the recipe never mentioned it), the insert/delete logic has a bug, or the server threw an unhandled exception. No change to the test data can fix this; the developer must edit code.

## How to decide

Ask: "Would sending DIFFERENT, corrected test data - still matching the intended schema - plausibly make this request succeed?"
- If yes → **recipe**.
- If the data shown below looks valid and the error points at the server's own logic, a missing factory, or a column/table the recipe never referenced → **implementation**.
- If you genuinely cannot tell from the evidence → **unclear**. Prefer "unclear" over a confident guess; a wrong confident answer is worse than admitting uncertainty.

Cross-check the error against the actual data sent below before deciding. For an "unknown alias" error, look at whether a record in the test data declares that alias with an _alias - NOT at the valid-targets list. If the alias the error names is missing from (or spelled differently in) the data we sent, it is recipe-side, even when that alias appears in the valid-targets list.

## Evidence

${phaseLine}
${statusLine}

Entity: "${args.entityName}"

Valid _ref targets (aliases declared by already-created parent entities):
${args.validRefAliases?.trim() || "(none - this is a root entity with no parents to reference)"}

What the entity audit recorded about how "${args.entityName}" is created:
${args.entityAudit?.trim() || "(not available)"}

${args.liveSchema?.trim() || "(no live schema available - the /discover endpoint was unreachable)"}

Test data sent:
${JSON.stringify(args.recipe, null, 2)}

Error:
${errorText}`;
}

/**
 * Ask the model whether a failure is recipe-side or implementation-side.
 *
 * Best-effort: any failure of the classifier itself resolves to `unclear`, which
 * the caller treats as "show the user the full menu and let them decide." The
 * classifier must never block or crash the failure-handling path.
 */
export async function classifyFailure(model: LanguageModel, args: ClassifyArgs): Promise<FailureClassification> {
    try {
        const result = await generateText({
            model,
            prompt: buildClassifierPrompt(args),
            output: Output.object({ schema: classificationSchema }),
            maxRetries: AI_MAX_RETRIES,
        });
        return result.output;
    } catch (err) {
        return { side: "unclear", reason: `Could not auto-triage this error (${formatException(err)}).` };
    }
}
