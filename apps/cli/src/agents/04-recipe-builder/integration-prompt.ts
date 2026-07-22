import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPLETION_MARKER_FILE } from "./completion";

/**
 * The integration recipe, rendered to a durable file. This single versioned
 * artifact drives the automated run, the manual fallback, and any debugging. It
 * must work on ANY project: it never assumes a framework, file extension,
 * directory convention, or routing scheme. It tells the agent WHAT to achieve and
 * lets it DISCOVER the stack - including how to run the app - with its own tools.
 *
 * The agent does ALL validation itself, per entity, driving the endpoint through
 * the CLI's own `sdk` commands and inspecting the database directly, then reports
 * the whole session done by writing a completion marker.
 */

/** Bump when the prompt's contract changes; surfaced in the file header. */
export const INTEGRATION_PROMPT_VERSION = 5;

/** The rendered prompt lives here in the app's planner output dir. */
export const INTEGRATION_PROMPT_FILE = "integration-prompt.md";

/** Preferred endpoint path unless the repo has a clearly better convention. */
const DEFAULT_ENDPOINT_PATH = "/api/autonoma";

export interface IntegrationPromptParams {
    /** The planner output dir holding the frozen artifacts (KB, audit, scenarios). */
    outputDir: string;
    /** Where the agent writes the recipe it generates and validates against. */
    recipePath: string;
    /** How the agent invokes this CLI's endpoint tool, e.g. `node /path/dist/index.js`.
     *  Used as `<cliCommand> sdk discover|up|down ...`. */
    cliCommand: string;
    /**
     * A note about why a prior session didn't complete, present only on a
     * re-launch, so the agent resumes rather than repeating finished work.
     */
    priorFailure?: string;
}

export function renderIntegrationPrompt(params: IntegrationPromptParams): string {
    const priorFailureSection =
        params.priorFailure != null
            ? `
═══ A PRIOR SESSION DID NOT COMPLETE - READ THIS FIRST ═══
${params.priorFailure}
Re-read your IMPLEMENTATION.md checklist, pick up at the first unfinished entity,
and do NOT redo entities already validated. Finish every remaining item, then write
the completion marker.
`
            : "";

    return `<!-- Autonoma integration prompt v${INTEGRATION_PROMPT_VERSION} -->
You are integrating Autonoma into THIS application, working in a LOCAL checkout of
the repo. The Autonoma planner has ALREADY run locally and produced its artifacts
(knowledge base, entity audit, scenarios) at:
    ${params.outputDir}
You are the developer picking up exactly where the planner hands off: implement the
test-data layer (the SDK integration), GENERATE the test-data recipe, and validate
it. Do NOT re-run the planner; read its artifacts as your spec.
${priorFailureSection}
Work without asking questions. Make reasonable, codebase-grounded decisions. Only
stop for missing secrets, credentials, or external services that genuinely cannot
be mocked or run locally - and when you do, say exactly what you need and why.

═══ DISCOVER FIRST (never assume) ═══
Before writing anything, investigate this specific app with your tools. Determine,
from the actual source, every one of:
  • language, package manager, and how to install/build/typecheck/lint/test
  • backend framework and how routes/handlers are declared
  • the auth system (sessions, JWT, cookies, a third-party provider) and how a
    request is authenticated end to end
  • the data layer (ORM/query builder/raw SQL), the models, and the REAL creation
    path for each model (services, repositories, invariants, required relations,
    enum values, defaults, side effects)
  • how the app is started and served locally, AND how to connect to its database
    to inspect rows (you will query the DB directly to verify each factory)
Do not pattern-match on file names or directory layouts. Read the code. The right
conventions are whatever THIS repo already uses - mirror them.

═══ GET THE APP RUNNING LOCALLY ═══
You need the app running to validate your integration. Bring it up locally the way
the repo documents: install dependencies, start whatever backing services it needs
(a database, a gateway, etc.), and start the server. Read the repo's own
README/scripts to learn how - do not assume. Note the URL your SDK endpoint answers
on; you pass it to the validation commands below.

═══ PREREQUISITES - STOP IF MISSING ═══
Autonoma generates END-TO-END tests that drive a real USER INTERFACE backed by its
APIs. This only works when BOTH a frontend/UI to exercise AND every backend service
that UI depends on are present and runnable. Before any integration work, confirm
both are here. If the UI is absent, or a backend the UI needs cannot be run locally,
STOP immediately and say EXACTLY what is missing and why you can't proceed.

═══ OBJECTIVE ═══
0. Read the planner's artifacts (knowledge base, entity audit, scenarios) in the
   output directory above. They are your spec for what entities and scenarios must
   exist. The planner is done; do not re-run it, and do NOT delete or modify anything
   already in that directory - you only ADD your recipe.json and the completion marker.
1. Install the Autonoma SDK and the backend adapter for THIS repo's language. The SDK
   is published for many languages under different package names and registries (npm,
   PyPI, Go modules, RubyGems, ...), so DISCOVER the correct package + adapter for this
   stack from the SDK docs (https://docs.autonoma.app/sdk) - do NOT assume the
   JavaScript/npm package.
2. Implement ONE endpoint (prefer "${DEFAULT_ENDPOINT_PATH}" unless the repo has a
   clearly better convention) that handles the discover / up / down protocol through
   the SDK handler. The signing secret AUTONOMA_SHARED_SECRET is ALREADY provisioned
   in the app's environment - verify the x-signature HMAC against that env value (the
   SDK reads it for you). Do NOT hardcode a secret or overwrite the env value.
3. Implement a real factory for EVERY entity the entity audit says needs one:
   • CREATE THROUGH THE APP'S OWN CODE, NOT RAW DB WRITES. The entity audit names a
     creation_function (and its side_effects) for each entity - call THAT function
     (inject or instantiate the service the app itself uses) so its real business
     logic and side effects actually run. A raw insert silently skips validation,
     hashing, derived fields, relation/permission wiring - exactly what this
     integration exists to avoid. The audit has no line numbers, so VERIFY each named
     creation_function actually exists in its creation_file; if the entry is stale,
     DISCOVER the real creation path yourself before wiring the factory. Fall back to
     a raw write ONLY when the real creation function genuinely cannot run locally.
     Even then, TRY it first and fall back only on an ACTUAL failure. When you fall
     back, say so for that entity and note which side_effects you reproduced by hand.
   • Some models have NO reusable creation function - the app writes them with an
     inline data-layer insert inside a request handler. For these, COPY that insert
     into your factory (open the named creation_file, replicate the exact insert, and
     DROP the handler's request/auth/external-service side effects), then give it a
     scoped-delete teardown. NEVER satisfy such a factory by calling the handler over
     HTTP. (Trace one level in first: if the handler delegates to a reusable function,
     call that instead; only copy the insert when the write is genuinely inlined.)
   • preserve invariants, relations, enums, defaults, and side effects
   • support recipe references (an _alias to name a created row, an _ref to point at
     another alias); create parents before children
   • return created refs in the shape the SDK expects
4. Implement teardown. PREFER deleting by the scoping root: if the app scopes data by
   a tenant (an organization / workspace / account - most do), tear down by deleting
   that scope and letting cascades remove everything under it. This is simpler AND it
   also removes rows a test created that were never in "up" (e.g. an invoice created
   mid-test), which per-record teardown would leak. Only when there is no such scope,
   fall back to deleting each created record in reverse dependency order. Either way,
   be idempotent where practical, and NEVER delete non-test data - scope strictly by
   the seeded tenant / the test run / a unique marker.
5. Implement the auth callback so the test runner gets REAL, usable credentials for
   the seeded user (valid cookies / a valid Authorization header / real login
   credentials) - never a placeholder token.
6. Leave a maintenance note so the integration stays in sync as the schema evolves.
   Find the repo's agent-instructions file (AGENTS.md or CLAUDE.md; check the app
   directory and repo root, or create AGENTS.md at the repo root). Append a short
   "Autonoma test data" section that (a) explains in 2-3 sentences what Autonoma is
   and that it seeds realistic test data through this endpoint's factories via the
   app's own creation paths, and (b) instructs the reader to add/update the matching
   factory whenever they add or change models or the code that creates them. Keep it
   brief and match the file's tone; don't duplicate an equivalent existing note.

═══ YOU GENERATE THE RECIPE ═══
There is no pre-written recipe. YOU build it at:
    ${params.recipePath}
It is a JSON file of the form:
    {
      "version": 1,
      "source": { "discoverPath": "discover.json", "scenariosPath": "scenarios.md" },
      "validationMode": "endpoint-lifecycle",
      "recipes": [
        { "name": "standard", "description": "<short>",
          "create": { "<EntityName>": [ { "_alias": "x_1", ...fields }, ... ] },
          "validation": { "status": "validated", "method": "endpoint-up-down" } }
      ]
    }
The "create" object maps each entity name to an array of records. Records use _alias
(to name a created row) and _ref (to point at a parent's alias). Populate it from
scenarios.md so the data realizes those scenarios. Build it up entity by entity as
you go (see the loop below) and keep the envelope intact.

═══ TRACK YOUR WORK - DO NOT STOP UNTIL IT IS COMPLETE ═══
Before implementing, write a checklist file inside the app (e.g. IMPLEMENTATION.md)
and keep it updated. It must enumerate, as explicit checkboxes: EVERY entity the
entity audit says needs a factory (by name, copied from the audit), plus the
endpoint, teardown, the auth callback, the maintenance note, and the full-recipe
pass. Check items off only when actually done and verified. The single most common
failure is stopping with entities left uncovered.

═══ VALIDATE - ENTITY BY ENTITY, THEN THE WHOLE RECIPE ═══
You validate your own work by driving the endpoint through THIS CLI's signed client
and inspecting the database. The CLI signs every request with the canonical secret
from the environment, so you never construct signatures yourself. The commands:
  • ${params.cliCommand} sdk discover --url <endpoint-url>
  • ${params.cliCommand} sdk up --url <endpoint-url> --recipe <file> [--timeout <seconds>]
        (prints JSON; the response body includes a "refsToken")
  • ${params.cliCommand} sdk down --url <endpoint-url> --refs-token <token-from-up>
The --recipe file may be your full recipe.json or a slice containing just the
entities under test. Each request times out after 120s by default; a cold
full-recipe up (first compile + many real-service inserts) can exceed that, so
pass --timeout <seconds> to raise it rather than falling back to smaller slices.

Work through the entities in dependency order (parents before children). For EACH
entity:
  1. Implement or fix that entity's factory.
  2. Add/fix that entity's records in the recipe (with its required parents present -
     the single-entity dependency chain; an Order needs its Customer).
  3. Write a slice file with just this entity (and its parents) and run:
        ${params.cliCommand} sdk up --url <url> --recipe <slice>
  4. Query the DATABASE directly and confirm the expected rows were created (right
     table, right values, relations wired) - not just that up returned 200.
  5. Run: ${params.cliCommand} sdk down --url <url> --refs-token <token-from-up>
  6. Query the DATABASE again and confirm those rows are GONE.
  7. If any check failed, fix the right thing - the FACTORY CODE or the RECIPE DATA,
     whichever the failure points to - and repeat from step 3. Loop until green.

Once every entity passes independently, run the FULL recipe as one pass:
  • ${params.cliCommand} sdk up --url <url> --recipe ${params.recipePath}  -> succeeds
  • confirm all rows created (DB), then down with the refsToken -> succeeds, rows gone (DB)
  • confirm a WRONG signature is rejected (the SDK does this for you - do not disable it)
  • confirm the up response's auth payload contains real credentials, not a placeholder

═══ FINISH - THE LAST THING YOU DO ═══
Only after every entity and the full-recipe pass are green, and ${params.recipePath}
holds the recipe you validated, write the completion marker so the CLI knows the
session is done and can upload the recipe:
    ${join(params.outputDir, COMPLETION_MARKER_FILE)}
Its contents MUST be exactly:
    { "complete": true }
Do NOT write this marker while any checklist item is unfinished. It is how control
returns to the CLI - it is not optional. The planner watches for this marker and
takes the terminal back shortly after it appears. After writing it, end with ONE
short closing message telling the developer:
    "The integration is done. The Autonoma planner takes this terminal back in a
    few seconds to continue the setup - or exit now to continue immediately."
Nothing after that message - no further questions, summaries, or work.`;
}

/** Render the integration prompt to its durable file and return the file path. */
export async function writeIntegrationPrompt(params: IntegrationPromptParams): Promise<string> {
    const path = join(params.outputDir, INTEGRATION_PROMPT_FILE);
    await writeFile(path, renderIntegrationPrompt(params), "utf-8");
    return path;
}
