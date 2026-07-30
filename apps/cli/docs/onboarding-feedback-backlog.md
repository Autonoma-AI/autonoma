# Onboarding feedback backlog (deferred items)

Triage of a colleague's end-to-end onboarding run (2026-07-24). Two items were taken and
shipped separately; everything below was deliberately **not** taken, and this file records why
plus what a future attempt would have to do.

Items are numbered F1-F7 after the original feedback so the numbering survives discussion.

## Rejected

### F2 - return email + password instead of session cookies

**Asked for:** the SDK auth callback should return `credentials` (email + password) rather than
cookies, because clients browse previews a lot and a cookie means fiddling with a browser
extension to use it.

**Decision: no.** Session cookies stay the default. They are faster and more reliable than
driving a UI login, and a UI login is sometimes not automatable at all (a `react-hook-form`
login button that never enables under browser automation is a case we have already hit). The
problem the request identifies is real, but it is a UI problem, not an auth-mechanism problem:
the answer is a button that applies the cookies and opens the app, not putting a password on
screen. See "Apply cookies and open the app" below for that button and what blocks it.

### F7a - cap the number of generated tests

**Asked for:** the planner generates too many tests, and a user who finishes onboarding and
sees half the suite red will think the product is broken.

**Decision: no cap.** The suite is a starting point, not a finished artifact; it evolves and
stabilizes with use. `05-test-generator` has no cap today and should not get one.

The concern behind the request is still open, but it is a different question: whether to keep
onboarding fast and set expectations better about a first suite, or to run a longer process
that exercises the suite and repairs the tests that are wrong out of the gate. That trade-off
is unresolved. Note that test-volume telemetry is thin (only a handful of runs carry
`test_count` on `cli_step_completed`), so decide it on product grounds rather than waiting for
the data to speak.

## Deferred

### F3 - the concurrent-`up` proof is self-reported, not verified

**Symptom:** the agent hardcoded a user email in the recipe, and every second `up` failed on a
unique constraint until the first instance was torn down.

**Why it happens:** the guidance is not missing. `integration-prompt.ts` already orders the
agent to enumerate uniqueness rules from the schema and the live database, and a
two-concurrent-instances proof is marked MANDATORY. Nothing checks that it happened. The CLI
takes the agent at its word: `completion.ts` accepts a `{"complete": true}` marker and
`runSubmit` uploads the recipe.

**Shape of the fix:** turn the proof into a gate the CLI runs itself. The agent records the
endpoint URL it validated against in the completion marker; the CLI then drives
`up A` + `up B` with no teardown between, tears both down, and on failure relaunches the agent
with the constraint violation as `priorFailure` (the relaunch path already exists). This
converts the most common integration defect from a prompt instruction into a deterministic
check.

**Status:** possibly already in flight elsewhere - confirm before starting. It was not in any
open PR or in merged history at triage time; the nearest work is the integration-eval harness
for the SDK-integration skill, which would catch this by eval rather than by gate.

### F4 - no scenario declares which user the tests run as

**Symptom:** the platform has several user types. The planner built a lot of data for one user
the agent then never logs in as, and the test generator went on to write tests for user types
that are unreachable in a run. The scenario also came out fairly basic.

**Why it happens:** nothing anywhere names the login persona, so each stage guesses
independently:

- `03-scenario-recipe/prompt.ts` has no role or persona modelling. It asks for realistic
  volumes and coverage of every entity type, which is what produces data for unreachable
  personas.
- The auth callback contract takes "the first `User` record from refs"
  (`apps/docs/.../environment-factory/authentication.md`), so which user the runner
  authenticates as is incidental.
- `05-test-generator/prompt.ts` only knows that the user is always already logged in. It has
  no way to tell that a surface belongs to a role the run cannot reach.

**Shape of the fix:** one concept threaded through all three. The scenario declares the persona
the tests run as; the auth callback must return credentials for that persona rather than
whichever user is first; the generator treats other-role surfaces as out of scope, the same way
it already excludes admin routes. Multi-persona support (a scenario per role) is the larger
version and should not be attempted in the same pass.

**Status:** under discussion. The right shape is not settled.

### F6a + F6c - the TUI does not show what it is doing or what you can do

Two symptoms with one root cause, so they are tracked together.

**F6a as reported:** "at the end of the analysis phase, let me review just `scenarios.md`" - it
is the input everything downstream is built from, so a wrong scenario means a wrong recipe and
wrong tests, discovered much later.

**F6a is already possible.** The FILES column and the artifact viewer are live for the whole
run: the navigation keys in `src/ui/App.tsx` are handled unconditionally, and the `browsing`
flag only changes what `q` does. `scenarios.md` is a registered artifact with a human title.
He could have opened it at any point and did not realize it. So this is discoverability, not a
missing capability, and a mid-run pause is the wrong fix.

**F6c as reported:** while a step runs, it is not clear what is happening inside it.

Related observation, useful as evidence rather than as its own item: he described the run as
having 3 steps (CLI analysis, SDK implementation, test generation). `STEP_ORDER` has 7, and the
finish-setup UI shows a different 3 (CLI, SDK, Dry run). Collapsing 7 into 3 and then naming a
third grouping is the same legibility problem F6c describes.

**Status:** needs input on what he expected to see versus what the dashboard already renders.
Not scopeable without it.

### Apply cookies and open the app (F2's replacement)

**Wanted:** one button on the test-user card that plants the seeded user's session on the
preview and opens it, so a human can browse a preview as that user without touching
credentials or a browser extension.

**Blocked, and not on product grounds.** The cookies belong to the preview origin, and only
that origin can set them:

- JavaScript on `autonoma.app` cannot set a cookie for a preview host. That is the whole
  reason the card currently offers a Cookie-Editor export and a `document.cookie` snippet.
- The `document.cookie` path cannot work in general anyway. A real session cookie is normally
  `httpOnly`, and the browser silently drops those when script tries to set them.
- A cookie scoped `Domain=autonoma.app` from our API *would* reach every preview host, which is
  exactly why it is not an option: it would also be sent to our own app and to every OTHER
  tenant's preview. Do not take this shortcut.

So it needs a `Set-Cookie` from the preview origin, which means the component that already
answers `/preview-auth` there. That is the gatekeeper, and it ships as a prebuilt image
(`public.ecr.aws/autonoma/gatekeeper`, pinned in
`deployment/previewkit/cluster/gatekeeper/gatekeeper.yaml`) whose source is not in this repo.
Today it only plants the previewkit **bypass** token, which is a different concern from the
customer app's own session.

**Shape of the fix:** a one-time signed handoff on the preview origin. The API mints a
short-lived blob holding the cookies to plant, signed with a secret the gatekeeper shares; the
browser is sent to that endpoint; the gatekeeper verifies the signature, emits the cookies as
`Set-Cookie`, and redirects to the app. The signature is load-bearing - an endpoint that
plants arbitrary cookies from a query string is a cookie-injection hole on the preview domain.

**Status:** needs a gatekeeper change, so it cannot start from this repo.

### F6b - push, open a PR, and browse a live `up` before tests are written

**Asked for:** between the SDK step and test generation, let the user push the implementation,
open a PR, run an `up`, and see it reflected in the UI. That is where you verify the
integration is genuinely right and still have the chance to change the recipe or the handler
before tests are written against it. The suggestion extends to replacing the dry-run step with
opening a PR and doing an `up` you can navigate.

**Confirmed gaps:** the CLI never mentions pushing or opening a PR (the run ends with "continue
on autonoma.app"), and the dry-run step tears its instance straight back down, so there is
nothing left to browse.

**Shape of the fix:** the UI half is mostly composition. `TestUserCard` already does provision,
credentials, open preview, and tear down; the work is surfacing it in the finish-setup dry-run
step rather than building anything new. The CLI half is a nudge to push and open a PR, which
the finish-setup UI then auto-detects.

**Status:** under discussion.

## What was taken

Recorded here only so the numbering has no holes.

- **F1** - every red SDK or scenario error offers the MCP fix path. The agent dialog existed but
  was wired into only a few surfaces; the provision-error banner and the scenarios page's
  dry-run note had no way to reach it.

## Positive signal worth keeping

The colleague's own summary, kept because it is the argument for the MCP investment: the SDK
was well implemented end to end (endpoint and factories), the only failure was the uniqueness
issue in F3, and with the MCP plus a rough mental model of how the pieces fit, fixing what the
agent produced was easy. Something will always break on a given customer's particularities; the
thing that matters is that repair is cheap.
