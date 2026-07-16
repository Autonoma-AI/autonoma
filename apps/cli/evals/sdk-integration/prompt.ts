/**
 * The prompt handed to the `claude -p` subinstance that plays the developer. The
 * planner has ALREADY produced its artifacts before Claude starts; this prompt
 * begins exactly where onboarding hands off to the developer: implement and
 * validate the SDK + recipe integration against a LOCAL checkout.
 *
 * THIS PROMPT MUST WORK ON ANY PROJECT. It must never assume a framework, a file
 * extension, a directory convention, or a routing scheme. It tells the agent WHAT
 * to achieve and lets the agent DISCOVER the stack - including how to run the app -
 * with its own tools. The only injected value is a per-run shared secret (a runtime
 * secret, not a recorded answer).
 */

/** The SDK to integrate - the same for every repo (the adapter is discovered). */
const SDK_PACKAGE = "@autonoma-ai/sdk";
/** Preferred endpoint path unless the repo has a clearly better convention. */
const DEFAULT_ENDPOINT_PATH = "/api/autonoma";

export interface IntegrationPromptParams {
    /** Pre-generated shared secret the endpoint verifies signatures against; already in the app env. */
    sharedSecret: string;
    /** Where the frozen planner artifacts are staged (readable, outside the sandbox). */
    artifactsDir: string;
}

export function renderIntegrationPrompt(p: IntegrationPromptParams): string {
    return `You are integrating Autonoma into THIS application, working in a LOCAL checkout of
the repo. The Autonoma planner has ALREADY run and produced its artifacts (knowledge
base, entity audit, scenarios, recipe) at:
    ${p.artifactsDir}
You are the developer picking up exactly where the planner hands off: implement and
validate the test-data layer (the SDK + recipe integration). Do NOT re-run the
planner; read its artifacts as your spec.

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
  • how the app is started and served locally (read its README and package scripts)
Do not pattern-match on file names or directory layouts. Read the code. The right
conventions are whatever THIS repo already uses - mirror them.

═══ GET THE APP RUNNING LOCALLY (best effort) ═══
You need the app running to validate your integration. Make a best-effort attempt to
start it locally: install dependencies, bring up whatever backing services the repo
needs (a database, a gateway, etc.) the way the repo documents, and start the dev
server. Read the repo's own README/scripts to learn how - do not assume. If some
dependency genuinely cannot run locally, get as far as you can, then say EXACTLY what
is blocking and validate against whatever you were able to bring up.

═══ PREREQUISITES - STOP IF MISSING ═══
Autonoma generates END-TO-END tests that drive a real USER INTERFACE backed by its
APIs. This only works when BOTH a frontend/UI to exercise AND every backend service
that UI depends on are present and runnable. Before any integration work, confirm
both are here. If the UI is absent, or a backend the UI needs cannot be run locally,
STOP immediately and say EXACTLY what is missing and why you can't proceed.

═══ OBJECTIVE ═══
0. Read the planner's artifacts (knowledge base, entity audit, scenarios, recipe /
   recipe-builder state) in the artifacts directory above. They are your spec for
   what entities and scenarios must exist. The planner is done; do not re-run it.
1. Install the Autonoma SDK (${SDK_PACKAGE}) and the adapter that matches THIS
   backend. Discover the correct adapter from the SDK's published packages/exports;
   don't guess from the framework name alone.
2. Implement ONE endpoint (prefer "${DEFAULT_ENDPOINT_PATH}" unless the repo has a
   clearly better convention) that handles the discover / up / down protocol through
   the SDK handler. The signing secret AUTONOMA_SHARED_SECRET is ALREADY provisioned
   in the app's environment - verify the x-signature HMAC against that env value (the
   SDK reads it for you). Do NOT hardcode a secret, and do NOT copy one from the
   planner artifacts or overwrite the env value; the test runner signs with exactly
   the secret in the environment, so any other value makes every signed request 401.
3. Implement a real factory for EVERY entity the entity audit says needs one:
   • CREATE THROUGH THE APP'S OWN CODE, NOT RAW DB WRITES. The entity audit names a
     creation_function (and its side_effects) for each entity - call THAT function
     (inject or instantiate the service the app itself uses) so its real business
     logic and side effects actually run. A raw insert silently skips validation,
     hashing, derived fields, relation/permission wiring - exactly what this
     integration exists to avoid. Fall back to a raw write ONLY when the real
     creation function genuinely cannot run locally (a hard dependency on an
     unreachable external). Even then, TRY it first and fall back only on an ACTUAL
     failure. When you fall back, say so for that entity and note which side_effects
     you reproduced by hand.
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
4. Implement teardown for every created record, in reverse dependency order,
   idempotent where practical. NEVER delete non-test data - scope strictly by the
   test run / returned refs / a unique marker.
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

═══ TRACK YOUR WORK - DO NOT STOP UNTIL IT IS COMPLETE ═══
Before implementing, write a checklist file inside the app (e.g. IMPLEMENTATION.md)
and keep it updated. It must enumerate, as explicit checkboxes: EVERY entity the
entity audit says needs a factory (by name, copied from the audit), plus the
endpoint, teardown, the auth callback, the maintenance note, and each validation
gate. Check items off only when actually done and verified. The single most common
failure is stopping with entities left uncovered - before you finish, re-read the
entity audit and confirm EVERY entity in its factory list has a working factory.
Incomplete factory coverage is a failure even if the lifecycle is green for the
entities you did build. Do NOT stop, summarize, or declare success while any item
remains unchecked. If you are truly blocked on an item by a missing external
dependency, say so explicitly for that item rather than quietly dropping it.

═══ VALIDATE (you own this - it is the part non-interactive normally skips) ═══
With the app running locally, exercise the endpoint with SIGNED requests. Sign every
request: header "x-signature" = HMAC-SHA256(rawJsonBody, AUTONOMA_SHARED_SECRET),
using the AUTONOMA_SHARED_SECRET already in the environment.
  • discover -> succeeds and lists the scenarios
  • for each single-entity dependency chain: up -> succeeds, then down with the
    returned refsToken -> succeeds
  • full recipe: up -> succeeds, then down -> succeeds
  • a request with a WRONG signature -> is rejected
  • the up response's auth payload contains real credentials, not a placeholder
When something fails, decide whether the cause is recipe data, factory code, auth,
env, or app runtime, patch the minimal correct thing, and re-validate. Loop until
green.`;
}
