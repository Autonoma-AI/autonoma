# @autonoma/api

Backend API server for the Autonoma platform. Exposes a tRPC API over HTTP with social sign-in (Google, GitHub and Microsoft), GitHub webhook handling, and organization-based multi-tenancy.

## Tech Stack

- **Runtime:** Node 22 (ESM-only)
- **HTTP Framework:** Hono
- **API Layer:** tRPC with SuperJSON transformer
- **Auth:** better-auth (Google, GitHub + Microsoft OAuth, session-based, Redis-backed with a Postgres copy)
- **Database:** PostgreSQL via Prisma (`@autonoma/db`)
- **Storage:** S3 via `@autonoma/storage`
- **Observability:** Sentry (logging, error tracking, tracing)
- **Analytics:** PostHog via `@autonoma/analytics`
- **Build:** tsup (bundled ESM, targets Node 22)

## Running

```bash
# From the monorepo root
pnpm dev           # starts API (port 4000) and UI (port 3000) concurrently

# From this directory
pnpm dev           # starts API with --env-file=../../.env and tsx watch
pnpm build         # production build via tsup
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check with auto-fix
pnpm test          # unit tests (vitest)
pnpm test:integration  # integration tests (vitest, Testcontainers)
```

## Environment Variables

Defined in `src/env.ts` using `@t3-oss/env-core` with Zod validation. Also extends env schemas from `@autonoma/db`, `@autonoma/logger`, and `@autonoma/storage`.

| Variable                                    | Required | Default                    | Description                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_PORT`                                  | Yes      | -                          | Port the server listens on (typically `4000`)                                                                                                                                                                                                                                                          |
| `GOOGLE_CLIENT_ID`                          | Yes      | -                          | Google OAuth client ID                                                                                                                                                                                                                                                                                 |
| `GOOGLE_CLIENT_SECRET`                      | Yes      | -                          | Google OAuth client secret                                                                                                                                                                                                                                                                             |
| `GITHUB_CLIENT_ID`                          | No       | -                          | GitHub **OAuth app** client ID (distinct from the `GITHUB_APP_*` repo-facing GitHub App). GitHub sign-in is registered only when this and the secret are both set; callback URL is `<BETTER_AUTH_URL>/v1/auth/callback/github`                                                                           |
| `GITHUB_CLIENT_SECRET`                      | No       | -                          | GitHub OAuth app client secret                                                                                                                                                                                                                                                                         |
| `MICROSOFT_CLIENT_ID`                       | No       | -                          | Microsoft Entra ID app client ID. Sign-in is registered only when this and the secret are both set; redirect URI is `<BETTER_AUTH_URL>/v1/auth/callback/microsoft`                                                                                     |
| `MICROSOFT_CLIENT_SECRET`                   | No       | -                          | Microsoft Entra ID app client secret                                                                                                                                                                                                                   |
| `MICROSOFT_TENANT_ID`                       | No       | `organizations`            | Which Entra directory may sign in. `organizations` accepts work/school accounts from any tenant and rejects personal Microsoft accounts; a tenant id restricts to one directory                                                                        |
| `NAMESPACE`                                 | No       | `local`                    | Kubernetes namespace this API runs in (`production`, `beta`, or a per-PR alpha). Namespaces the session keys in the cluster-wide Redis, which every environment shares                                                                                                                                  |
| `OAUTH_PROXY_PRODUCTION_URL`                | No       | -                          | The one origin whose OAuth callback is registered with Google/GitHub, fleet-wide. Every environment sets the same value; the one whose own `APP_URL` matches it skips proxying and handles the callback for the rest. Leave unset locally                                                                |
| `OAUTH_PROXY_SECRET`                        | No       | `BETTER_AUTH_SECRET`       | Encrypts the profile payload handed back to the originating environment. Deliberately separate from `BETTER_AUTH_SECRET`, since it is shared across environments and a leak must not also forge sessions                                                                                                |
| `REDIS_URL`                                 | Yes      | -                          | Redis connection URL (sessions, caching)                                                                                                                                                                                                                                                               |
| `APP_URL`                                   | No       | `http://localhost:3000`    | Frontend URL for redirects                                                                                                                                                                                                                                                                             |
| `BETTER_AUTH_URL`                           | No       | -                          | This API's own origin, used for better-auth's `baseURL` (OAuth redirect URIs, issuer metadata); falls back to `APP_URL` when unset. Only diverges from `APP_URL` when the UI and API have different origins (local dev, previewkit)                                                                    |
| `ALLOWED_ORIGINS`                           | No       | `http://localhost:3000`    | Comma-separated CORS origins                                                                                                                                                                                                                                                                           |
| `INTERNAL_DOMAIN`                           | No       | `autonoma.app`             | Domain for internal users and cross-subdomain cookies                                                                                                                                                                                                                                                  |
| `AGENT_VERSION`                             | No       | `latest`                   | Version tag for Temporal worker agent images                                                                                                                                                                                                                                                           |
| `POSTHOG_KEY`                               | No       | -                          | PostHog API key (analytics disabled if absent)                                                                                                                                                                                                                                                         |
| `POSTHOG_HOST`                              | No       | `https://us.i.posthog.com` | PostHog ingest host                                                                                                                                                                                                                                                                                    |
| `LLM_PROXY_ENABLED`                         | No       | `false`                    | Master switch for the managed LLM proxy (`/v1/llm-proxy`, planner CLI). Mounted only when this AND `STRIPE_ENABLED` are true.                                                                                                                                                                          |
| `OPENROUTER_API_KEY`                        | No       | -                          | Server-side OpenRouter key the LLM proxy forwards with. Required for the proxy (`503` without it).                                                                                                                                                                                                     |
| `LLM_PROXY_ALLOWED_MODELS`                  | No       | planner model              | Comma-separated allowlist of models the proxy may route. Defaults to `google/gemini-3-flash-preview`.                                                                                                                                                                                                  |
| `LLM_PROXY_FREE_CREDIT_CAP`                 | No       | `20000`                    | Max credits a never-paid org may spend through the proxy, out of its free-start grant. Credits the org has paid for (top-up purchases + subscription grants, net of refunds) raise the budget; an active subscription lifts it. Abuse guard against farmed free accounts draining credits via the CLI. |
| `LLM_PROXY_MAX_OUTPUT_TOKENS`               | No       | `32768`                    | Per-request `max_tokens` ceiling. The proxy clamps (and defaults) each request to this so an allowlisted model can't be driven with an unbounded generation.                                                                                                                                           |
| `LLM_PROXY_MAX_REQUEST_BYTES`               | No       | `16000000`                 | Per-request body-size ceiling (bytes). Sized to comfortably fit a full ~1M-token context-window request (which the planner legitimately builds) plus JSON/UTF-8 overhead; only blocks payloads several times the model's own limit. Oversized payloads are rejected with `413`.                        |
| `GITHUB_PR_CACHE_REVALIDATE_WINDOW_MINUTES` | No       | `5`                        | Throttle window for the read-triggered PR-metadata cache revalidate (per app); one open-list call, plus one closed-list call when PRs need merged-vs-closed classification                                                                                                                             |
| `MERGE_GATE_ENABLED`                        | No       | `false`                    | Global master kill switch for the Autonoma merge gate (the blocking `Autonoma` check). Effective gate = this AND the org's `OrganizationSettings.mergeGateEnabled`. Must match the diffs worker's value. Never enable fleet-wide without per-org opt-in.                                               |
| `GITHUB_INSTALL_FRESHNESS_MINUTES`          | No       | `30`                       | How recently GitHub must have created an installation for the install callback to bind it to an organization for the first time. Signed install state names an organization but never an installation, so freshness is what stops a replay against an enumerated installation id. Lower it only in a test environment - it is what makes the "installation too old" path reachable without a 30-minute wait.                                        |
| `MERGE_GATE_SLACK_CHANNEL`                  | No       | -                          | Channel (`C0123…` id or `#name`) the merge-gate skip alert posts to via the `SLACK_BOT_TOKEN` bot (`chat.postMessage`; who + PR + reason). Unset (or no bot token) = alerts are silently skipped.                                                                                                      |
| `TESTING`                                   | No       | `false`                    | Test environment flag - prevents loading production modules                                                                                                                                                                                                                                            |
| `AUTONOMA_SHARED_SECRET`                    | No       | -                          | HMAC secret shared with the Autonoma self-hosted E2E test runner, used to verify signatures on `POST /api/autonoma`. When unset (the default in prod and most alphas), the endpoint mounts an inert `503`.                                                                                             |
| `AUTONOMA_SIGNING_SECRET`                   | No       | -                          | Server-private secret that signs the refs-token authorizing `down` teardown on `/api/autonoma`. Must be set together with `AUTONOMA_SHARED_SECRET` to activate the endpoint.                                                                                                                           |

Additionally, the inherited env schemas require database (`DATABASE_URL`), logger (`SENTRY_DSN`, `NODE_ENV`), and storage (`S3_BUCKET`, AWS credentials) variables.

## Architecture

### Request Flow

```
Hono HTTP server
  ├── /health              - health check
  ├── /api/autonoma        - Autonoma SDK test-data endpoint (HMAC-signed; self-hosted E2E only, inert 503 when unconfigured)
  ├── /v1/auth/**          - better-auth (Google, GitHub + Microsoft OAuth, sessions)
  ├── /v1/github/**        - GitHub webhooks and API endpoints
  ├── /v1/previewkit/**    - Previewkit environments + secrets (secrets/status/schema native; deploy/teardown/redeploy forwarded to Previewkit)
  ├── /v1/setup/**         - test planner setup (API key): setups, events, artifacts, scenario-recipe-versions
  ├── /v1/llm-proxy/**     - managed LLM proxy for the planner CLI (API key): chat/completions
  ├── /v1/mcp              - MCP server for coding agents (OAuth or API key); /v1/mcp/debug and /v1/mcp/onboarding are aliases
  └── /v1/trpc/*           - tRPC fetch adapter
```

### MCP surface (`/v1/mcp`)

One server carries every Autonoma tool: onboarding an application (pinned by a pairing code, keyed by
`applicationId`) and debugging a reviewed pull request (keyed by `repoFullName`), plus the tools both
jobs share, which take either identity. `/v1/mcp/debug` and `/v1/mcp/onboarding` are permanent aliases
serving the same tools - what differs is the guidance a client reads on connect and the `server`
property on the `mcp.tool_called` analytics event, so usage per address stays distinguishable.

`build-mcp-server.ts` composes the surface from registration functions onto one `McpServer`, so
"every address serves the same tools" is a property of that file rather than an agreement between
builders. Those functions are groupings, not surfaces: `registerDebugTools` and
`registerOnboardingTools` hold the tools only one job uses, and `registerReadTools` /
`registerApplyConfigTool` / `registerRecipeTools` hold the ones both jobs reach for.

Writes run through `createWriteGuard`, which decides per call whether the write serializes with a
human. That decision is about the application, not the address: while an agent is driving an
application's onboarding, a user is watching a read-only config screen, so the write takes the
`OnboardingAgentSessionService` soft mutex and appears on that screen's activity feed (and stands
down when the user takes over). On an application nobody is configuring, the same tool just runs.
`isAgentDrivenApplication` (`routes/onboarding/agent-session-liveness.ts`) holds the rule.

### Managed LLM proxy (`/v1/llm-proxy`)

The planner CLI (`@autonoma-ai/planner`) runs on managed Autonoma credits instead of a
user-supplied OpenRouter key. It points its OpenRouter AI-SDK provider at
`${AUTONOMA_API_URL}/v1/llm-proxy` and authenticates with its Autonoma API token (same
`requireApiKey` path as `/v1/setup`).

The route is gated on `LLM_PROXY_ENABLED` (default `false`) so it is never an accidental
unmetered gateway - it is only mounted where explicitly enabled. Metering requires
`STRIPE_ENABLED=true`; when the proxy is enabled with billing off (e.g. a test environment)
requests are served but **not** metered and a startup warning is logged. The proxy:

1. Bounds the raw request body to `LLM_PROXY_MAX_REQUEST_BYTES` (`413 request_too_large` otherwise).
2. Enforces a model allowlist (`LLM_PROXY_ALLOWED_MODELS`, default = the single model the planner uses, `google/gemini-3-flash-preview`).
3. Runs the credit gate (`checkLlmProxyGate`, all refusals are `402` so the CLI surfaces a billing hint):
    - `out_of_credits` - the wallet is empty.
    - `grace_period_expired` - subscription payment overdue.
    - `free_cli_limit_reached` - a never-paid org has spent its free CLI allowance (`LLM_PROXY_FREE_CREDIT_CAP`, default 20k of the 100k free-start grant). Credits the org has paid for (top-up purchases + subscription grants, net of refunds) raise the budget one-for-one, so a paying/formerly-paying org is never blocked at the free cap; an active subscription lifts the cap outright. This is the primary abuse bound: a farmed free account can drain at most the cap through the CLI, regardless of concurrency.
4. Clamps `max_tokens` to `LLM_PROXY_MAX_OUTPUT_TOKENS` (and sets it when omitted) so a single request stays cheap - keeping any overspend past the cap under concurrency negligible.
5. Forwards `chat/completions` to OpenRouter with the server `OPENROUTER_API_KEY`, streaming the
   response back unchanged.
6. Meters the dollar cost OpenRouter reports (usage accounting) into credits at the top-up rate and
   deducts from `BillingCustomer.creditBalance`, recording a `LLM_PROXY_CONSUMPTION` transaction
   (idempotent on the OpenRouter generation id). Surfaced in the billing UI as "AI CLI usage".

Returns `503` when `OPENROUTER_API_KEY` is unset.

**Known limitation (concurrency):** the balance gate and the deduction are separate reads, so an
org near zero balance that fires N concurrent requests can have all N served (each costing real
OpenRouter tokens) while the balance only floors at zero. Per-call cost is tiny and the gate still
blocks once the wallet is empty, so the overspend is bounded; tighten with per-API-key rate limiting
(the `ApiKey` model already carries `rateLimit*` fields) or an atomic check-and-reserve if CLI volume
grows.

### Merge gate (the blocking `Autonoma` check)

Per-org opt-in blocking GitHub check on client bugs, skippable with a `/autonoma-skip <reason>` PR comment. Off by
default and bounded by the global `MERGE_GATE_ENABLED` kill switch; enabled per trusted org via the internal
`admin.setMergeGateEnabled` procedure.

- `MergeGateService` (`src/github/merge-gate.service.ts`) owns the API-side lifecycle: post the pending `Autonoma`
  check on `pull_request.opened/synchronize/reopened/ready_for_review`; start requested analysis runs from the
  on-demand activation triggers (`/start analysis` comment, `pull_request.labeled`); honor a
  `/autonoma-skip <reason>` comment on
  an `issue_comment.created` webhook (resolve the PR's current check, write a `SkipRecord` snapshotting the open
  bugs + the reason, flip the check to `neutral`, post a `skipped`-state attribution comment, and fire a best-effort
  Slack alert via `MergeGateSlackNotifier` - the `SLACK_BOT_TOKEN` bot posting to `MERGE_GATE_SLACK_CHANNEL`); a
  reason is mandatory, so a bare or whitespace-only `/autonoma-skip` does not skip - it replies asking for a reason
  and leaves the check failing; persist merge
  facts and detect a "merged around us" bypass on `pull_request.closed`; and, on enable/disable, create/remove a
  repo ruleset that requires the `Autonoma` check on ALL branches - so every PR is gated regardless of its base
  branch, not only the default branch. The check, verdict, and skip already apply to every PR on any branch; the
  ruleset is only what makes a `failure` actually block the merge.
- The verdict -> conclusion mapping runs in the **diffs worker** after authoritative analysis settlement, through
  `settleAnalysisRun` / `settleAnalysisGitHub`; the PR comment is also an effect of that terminal path. The shared
  check-run store and the pure verdict mapping live in
  `@autonoma/github/check`.
- Fail-open on a job error (conclusion `neutral`); fail-closed if Autonoma is fully unreachable (the required check
  never reaches success, so only a repo admin can override). See `merge-gate-implementation-spec.md`.
- **Activation** (`OrganizationSettings.activationEnabled`, off by default): an org migrated to activation never
  starts an automatic PR run on its own. `MergeGateService.requestAnalysisRun` is the single entrypoint every
  trigger calls - it flips the `Autonoma` check to in-progress FIRST, then fires the analysis run (the run
  preview-ready used to start automatically); doing the flip before the run, inside the same per-head lock the
  worker's finalize takes, keeps a late flip from clobbering the finalize's verdict. On a real start it records the
  activation (`activationSource` + `activatedByLogin` on `GitHubCheckRun`, an `ANALYSIS_RUN_SOURCE` value from
  `@autonoma/github/check`) and emits `merge_gate.activated`; if no run starts (no preview, or nothing new) the
  check is restored to the un-requested neutral state and the requester is told why. Only a migrated org honors an
  explicit request - an un-migrated org still runs automatically, so `/start analysis` there is a no-op. Requests
  come from three on-demand triggers, each flipping the check to in-progress and stamping a distinct
  `ANALYSIS_RUN_SOURCE`:
    - `comment` - a `/start analysis` PR comment (`requestStartFromCommentWebhook`), authorized to write-access
      commenters the same way skip is.
    - `mcp` - the `start_analysis` debug-MCP tool a coding agent calls from the editor.
    - `label` - the repo's configured `ApplicationTriggerConfig.analysisTriggerLabel` (default `autonoma:analyze`)
      being added to a PR (`requestStartFromLabelWebhook`). Labeling a DRAFT is a no-op that replies with guidance
      to mark the PR ready first (a draft has no preview to run against), rather than bouncing off `no_preview`.
      `postPending` auto-creates that label on the repo for activation orgs (before it takes the per-head check
      lock, since the label is repo-level and best-effort) so a developer can find and add it.
      Unlike `comment`, the `label` trigger does not run an explicit write-access check: GitHub already gates adding a
      PR label (triage+), so the action itself is the authorization.
      There is also one **automatic** trigger, `ApplicationTriggerConfig.autoRunOnReadyForReview` (off by default): when
      a repo opts in, an activation org auto-runs the analysis as soon as a non-draft PR's preview is live. Crucially it
      fires from the shared PR-diffs trigger (`autoRunsOnReady` lets the automatic preview-ready run through the
      activation gate), NOT from the `pull_request.ready_for_review` webhook - at webhook time the preview does not
      exist yet (it is built in response to that event), so triggering there would always find no preview. Because it
      rides the automatic run path rather than `requestAnalysisRun`, the diffs worker's **`openMergeGate`** step (the
      analysis pipeline's stage 0) flips the un-requested neutral check to the in-progress "Analyzing" state and stamps
      `activation_source = ready_for_review` at run start, mirroring the on-demand triggers; the worker's finalize then
      posts the verdict.
      Per-repo trigger config lives on `ApplicationTriggerConfig` (1:1 with `Application`); absence means the code
      defaults apply (see `readActivationTriggerConfig`). Because a migrated org's un-requested PR has no run,
      `postPending` posts a COMPLETED `neutral` "No analysis requested - comment `/start analysis` to run." check
      rather than a hanging `in_progress` one, so a required check never wedges the merge. The automatic PR run is
      suppressed in the shared PR-diffs trigger (both the preview-ready and Vercel paths funnel through it)
      via a `requested` flag; main-branch baseline runs pass `isMainBranchRun` and are never gated (the base snapshot
      must keep updating), and un-migrated orgs (the fleet default) keep the current automatic behavior and the
      `in_progress` check.
- **One run per commit (dedupe)**: `requestAnalysisRun` takes a per-head advisory lock, so triggers for the same
  head serialize. A second trigger whose head already has an in-flight run (in-progress check + activation stamp)
  no-ops in the trigger handler; for a genuinely concurrent pair the handler pre-check cannot intercept (both
  read "not in flight" before either takes the lock), the trigger attaches a `requested` run to the
  existing pending snapshot for that head instead of superseding it, so no duplicate snapshot/run is created. In
  that race the later trigger still overwrites the recorded `activationSource` and emits a second
  `merge_gate.activated`; this is accepted, as de-duplicating it would require changing the untouchable
  `requestAnalysisRun`.
- **Requires GitHub App settings** (non-code): the `checks: write` permission, the `issue_comment` webhook
  subscription (for `/autonoma-skip` and `/start analysis`), the `pull_request.labeled` webhook subscription (for
  the activation label trigger - GitHub does not deliver labeled events without it), and `administration: write`
  for programmatic branch protection. Nothing functions until these are applied.
- **Per-developer attribution** (`BranchContributorService`, `src/github/branch-contributor.service.ts`):
  stickiness is an individual habit, so a branch's outcome must attribute to ALL its authors, not just the
  opener. On `pull_request.opened/synchronize/reopened/ready_for_review/closed` it resolves the PR's full
  contributor set - every commit author (login when GitHub linked the email to an account) plus every
  `Co-authored-by:` co-author (kept as name/email, unresolved) plus the opener - and upserts one
  `BranchContributor` row per person, keyed by `(repoFullName, prNumber, contributorKey)` and accumulating
  across pushes. It also exposes `resolveFixingPushAuthors`,
  which returns the commit authors (including `Co-authored-by:` co-authors) for a given push/commit SHA. The
  `merge_gate.skipped` and `merge_gate.bypassed` PostHog events already carry the
  actor login (`actorLogin` / `mergedByLogin`) so the funnel breaks down per developer. Pure co-author
  parsing and contributor resolution live in `@autonoma/github` (`resolveContributorsFromCommits`,
  `parseCoAuthoredByTrailers`).

- **Bug-fixed-before-merge** (`BugFixOutcomeService`, `src/github/bug-fix-outcome.service.ts`): the stickiness
  "did it help?" measurement. On `pull_request.closed` for a merged PR of a gate-enabled org (hooked in right
  after `MergeGateService.recordMergeFromWebhook`), it records - per client bug we flagged - whether it was fixed
  before merge. It reads persisted state only and never re-runs analysis: the Reporter already resolves the
  branch-scoped `AnalysisIssue`s each run, so at merge time an issue's `status` already says whether the bug still
  reproduces. Per branch bug issue (`kind: "bug"`; environment/scenario are ignored): `resolved` ->
  `fixed_before_merge`, `open` -> `merged_with_bug`. A skipped PR records `skipped` - the `SkipRecord` is matched by
  the merged head SHA (like the gate's bypass detection), so a skip on a head later superseded by a fixing push does
  not hide the fix. A PR the analysis never authoritatively assessed (no completed `AnalysisReport` on the branch's
  latest non-twin run at or before the merge) records a single branch-level `unknown` marker; a clean PR records
  nothing. Outcomes persist to the FK-less tracking table `BugFixOutcome`, unique per `(branchId, issueId)`. It
  emits the `bug.fixed` and `bug.merged_open` PostHog events (`@autonoma/github/check` `BUG_FIX_OUTCOME_EVENT`) with
  an explicit distinctId and the org group; `skipped`/`unknown` emit no event, so a bypass is never double-counted
  against a per-bug signal. When a `BranchContributorService` is injected it attributes each fix to the authors of
  the resolving push (via `resolveFixingPushAuthors`, mapped from the issue's `resolvedAt`), riding their logins on
  `bug.fixed`.

### Explicit deploy requests are not refusable

`PreviewkitTriggerService` has two kinds of entry point, and they answer to different authorities.

A trigger that came from GitHub (`startRunFromPullRequestWebhook`, `startMainBranchRunFromPushWebhook`)
opens an analysis run, and that run decides whether the commit warrants a preview at all - impact
analysis selecting no tests means no build.

A trigger that came from a person or an agent - the UI redeploy button, `apply_config` and
`trigger_deploy` over MCP, the `/v1/previewkit` HTTP routes, the admin actions - is a request for the
preview itself, not a verdict on the commit. Those paths (`startRunForRedeploy`,
`startRunForPullRequest`) launch the build directly with reason `force_build` and never consult
analysis, because an application whose test suite does not exist yet selects nothing and would be
refused every time - which is exactly the state an application is in while it is being set up.

A redeploy of an environment that does not exist yet first-deploys instead of reporting the
environment missing: the repository id is read from another environment the organization has for the
same repo, the head from GitHub, and environment 0 goes through `startMainBranchRun` (only the
Application knows which branch it deploys). The credits gate still applies to all of it.

### Previewkit deploy credits gate

A new preview deploy or per-app redeploy (never teardown) is declined once an org's combined
`BillingCustomer.creditBalance` is at or below zero - `PreviewkitTriggerService.deploy()` /
`.redeployApp()` call `checkPreviewDeployCreditsGate` before launching the Kubernetes Job. Gated by
two switches so enforcement rolls out per org without affecting anyone else:

- `PREVIEWKIT_BILLING_ENABLED` (default `false`) - the global master switch. Off means no org is
  ever blocked, no matter its own setting.
- `OrganizationSettings.previewkitBillingEnabled` (default `false`) - per-org opt-in, only
  consulted once the global switch is on.

A blocked deploy throws `InsufficientPreviewCreditsError` (`402` on the `/v1/previewkit` HTTP
routes) and posts a PR comment explaining why before throwing, so every trigger path - GitHub
webhook, HTTP route, or admin action - surfaces the same explanation regardless of how the deploy
was started. Usage still accrues and bills via the separate 15-minute usage-meter sweep
(`apps/cronjobs`) whether or not enforcement is on; this gate only controls whether a _new_ deploy
is allowed to start.

### PreviewKit config preflight

The onboarding PreviewKit config editor warns on app paths and Dockerfiles that do not exist in the
linked repo, backed by two collaborators in `src/github/`:

- `RepoReader` - shared read-only repo access (installation client, per `(repo, head SHA)` file-tree
  cache, and `package.json` / file-content readers).
- `RepoIntrospectionService` - the repo's file tree at its default-branch head, for the preflight
  checks and the config editor's Dockerfile picker.

Every GitHub failure degrades to `undefined`, so preflight warns less rather than blocking the
editor. Nothing here runs AI - the API server does no model inference of its own.

### Onboarding funnel analytics

Activation is instrumented end to end so a stalled customer is visible without asking them. `OnboardingAnalytics` (`src/routes/onboarding/onboarding-analytics.ts`) emits it; nothing is captured from inside a handler.

| Event                                   | Emitted from                                       | Answers                                                                          |
| --------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `onboarding.step_changed`               | every path that moves the step - see below         | Which stages people actually reach (`fromStep`/`toStep`, `surface`, `action`)     |
| `onboarding.procedure_called`           | every onboarding tRPC mutation                     | What they retried and what it failed with (`success`, `durationMs`, `errorName`)  |
| `onboarding.deployment_signal_received` | the signal endpoint (`POST /v1/onboarding/signal`) | Whether the customer's CI ever posted, and what we did with it                    |
| `onboarding.dry_run_passed`             | `OnboardingSdkCapabilityService.runDryRun`, success path only | Who actually finished setting up, and when (`scenarioId`)              |
| `vercel.*`                              | `src/vercel-marketplace/vercel-analytics.ts`       | The Marketplace half: resource provisioning, plan changes, uninstalls, failed SSO |

`dry_run_passed` is the only one of these that means the customer's integration actually works: reaching `step = completed` is wizard clicks, and on the Vercel path `preview_verified` is reached by picking a deployment out of a dropdown. It is emitted beside the `dryRunPassedAt` stamp so the event cannot drift from the column, and **on the success path only** - a failed dry run returns `{ success: false }` rather than throwing, so the `onboarding.runScenarioDryRun` mutation event fires identically either way and cannot be used to count it. Emitting only on success is also what keeps the customer's endpoint error text - which has included a live credential - out of PostHog.

`step_changed` reaches the funnel two ways, and its `surface` property says which:

- **Inferred from a before/after read** (`surface: ui | agent`), by `onboardingWriteProcedure` around every onboarding mutation and by `guardedWrite` around every MCP tool write. Because the step is read either side of the call, a transition is caught wherever it was written - a state subclass, a capability service, a nested `writePreviewUrl` - rather than only where a handler remembered to say so.
- **Reported directly by the caller** (`surface: signal | system`), for the two paths no tracker wraps. `preview_verified` - the funnel's central conversion - is stamped by `writePreviewUrl`, which is also reached by the deployment-signal HTTP handler and by the `getPreviewReadiness` poll. Instrumenting only the wrappers would have counted that conversion for Vercel customers and nobody else. `writePreviewUrl` returns whether it advanced and from which step, so the "did it advance?" condition has exactly one definition, and both callers hand that straight to `stepAdvanced`.

Two further design points matter when extending this:

- **Mutations only.** Queries deliberately stay on `protectedProcedure` - the onboarding UI polls several of them continuously, and instrumenting reads would bury the funnel in poll traffic. A failing read is already captured browser-side. The readiness poll above is the one exception and costs a read only on the poll that actually flips the step.
- **Analytics never breaks a request.** Every emit path swallows its own failure into a warning.

`distinctId` is the acting user's id, matching `posthog.identify` in the browser, so these sit in one funnel with the client-side `onboarding.opened` and `onboarding.step_viewed` (both emitted from `apps/ui/src/routes/__root.tsx`). The two machine surfaces have no user - the customer's CI posts the signal, and the poll observes a deploy rather than an action - and are attributed to the organization instead. The client events count steps a user *saw*; the server events count steps the backend *persisted* - the gap between them for a given step is the drop-off.

### Organizations and memberships

`member` is a true join table (`@@unique([userId, organizationId])`), so **an account can belong to
several organizations**. Which one it is *acting as* is session state - `session.activeOrganizationId`,
held in Redis - not a property of the user. Two browsers can therefore be signed in as the same
account in two different organizations.

Three things put a membership on an account:

- **Auto-join by domain.** `ensureOrgMembership` (`src/auth.ts`) upserts an organization keyed on
  `organization.domain` at first sign-in. A bare domain (`acme.com`) means everyone with an
  `@acme.com` address lands in the same org; a full email address (`tom@gmail.com`) means the org is
  that one person's. `orgHasAutoJoinDomain` (`@autonoma/types`) is the single encoding of that
  distinction - do not re-derive it by string-matching a domain.
- **Invitations** (`organization.invite` / `acceptInvitation`). Accepting **adds** a membership and
  points the session at it; nothing the user already belonged to is touched. Inviting an address that
  would auto-join by domain anyway is refused server-side, with an error saying so - but the Members
  page itself is shown for **every** organization. It was once hidden for auto-join orgs, which
  created a trap: someone invited into one could join it and then had no way to leave, because
  `Leave` lives on that page. Invitations go out as `RESEND_INVITES_FROM_EMAIL`, not the default
  `RESEND_FROM_EMAIL` - the default also sends the onboarding email, which is deliberately from a
  person, and an invitation from someone's personal address reads as a mistake.
- **Vercel Marketplace installs and the admin org switcher**, which both upsert directly.

`organization.setActive` is what switches organizations, and it replaces better-auth's
`organization/set-active` (refused in the middleware) because the plugin cannot write
`user.lastOrganizationId` - without which every new session falls back to the oldest membership and a
multi-org user is dropped into the wrong place on each sign-in. The active organization stays *session*
state; `lastOrganizationId` only decides where a **new** session starts, so two browsers can differ.

`organization.rename` also stamps `organization.nameConfirmedAt`. An org created from a personal email
address is named after whoever signed up first - not necessarily whose org it is - so `needsNaming` on
`auth.activeOrg` asks once and that stamp is what stops it asking again.

`organization.leave` is the inverse, and refuses two cases via `resolveLeaveBlockedReason` - shared by
the read that renders the button and the write that performs the leave, so they cannot disagree:

- `last-organization`: an account with zero memberships can reach nothing, and `ensureOrgMembership`
  would mint a fresh empty org on their next sign-in rather than returning them anywhere useful.
- `last-member`: nothing could ever grant access to a memberless organization again, so its
  applications would be unreachable.

Two ordering rules exist because "which organization?" has more than one answer:

- **`ensureOrgMembership` starts a session in `user.lastOrganizationId`**, falling back to the
  oldest membership. The remembered choice is joined through `member`, so one naming an org the user
  has since left is ignored rather than trusted. The fallback is ordered because an unordered
  `findFirst` drifted between sign-ins for multi-org accounts - which is why the Vercel path needed
  `vercelPreferredOrgKey` in Redis to force a specific org.
- **`AuthService.getOrgStatus` reads the *active* org's status**, not "some org this user is in".
  Unordered, an account approved in one org and pending in another was sent to `/pending` or not
  depending on row order.

**A session lives in more than one place, so never write one by hand.** The `session` table is the
durable copy (`session.storeSessionInDatabase: true`), Redis is the cache `getSession` reads first,
and Redis also holds an `active-sessions-<userId>` index beside it. `setSessionActiveOrg` delegates to
better-auth's `internalAdapter.updateSession`, which updates all three - it runs the durable write via
`executeMainFn: options.session.storeSessionInDatabase`. Reaching for `secondaryStorage.set` instead
touches only the cache, and since the shared Redis runs `maxmemory 400mb` with `allkeys-lru`, an
evicted session leaves the user signed in (Postgres backs them) while every write silently finds no
key and does nothing. That is what made every `organization.setActive` a no-op on beta.

**Losing a membership has to end access, not just delete a row.** `protectedProcedure` authorizes on
`session.activeOrganizationId` and never re-checks `member`, so a session already acting as the lost
organization would keep full access until it expired - days. `evictSessionsFromOrg` therefore runs on
both `leave` and `removeMember`: sessions aimed at the lost org move to a remaining membership (or are
revoked outright when none is left), sessions working in an unrelated org are untouched, and any
`lastOrganizationId` pointing at it is cleared. Getting this right for `leave` but not `removeMember`
was a real hole - a removed user kept access.

The `organization()` better-auth plugin's own membership endpoints (`invite-member`,
`accept-invitation`, `add-member`, `leave`, `set-active`, ...) are refused in the `hooks.before` middleware: they
bypass the invitation checks, the leave guards and the session re-pointing above. Its read endpoints
(`list`, `set-active`) stay open - the org switcher uses them.

### tRPC Routers

Each router is thin wiring - business logic lives in the corresponding service class. Routers are defined in `src/routes/` and composed in `src/routes/router.ts`.

| Router         | Service                     | Domain                      |
| -------------- | --------------------------- | --------------------------- |
| `admin`        | `AdminService`              | Admin operations            |
| `auth`         | `AuthService`               | User and session management |
| `applications` | `ApplicationsService`       | Test target applications    |
| `branches`     | `BranchesService`           | Test suite branches         |
| `folders`      | `FoldersService`            | Test organization           |
| `runs`         | `RunsService`               | Test execution runs         |
| `generations`  | `TestGenerationsService`    | AI test generation          |
| `tests`        | `TestsService`              | Test cases                  |
| `scenarios`    | `ScenariosService`          | Execution scenarios         |
| `github`       | `GitHubInstallationService` | GitHub app integrations     |
| `onboarding`   | `OnboardingService`         | User onboarding             |
| `organization` | `OrganizationService`       | Members and invitations     |
| `snapshotEdit` | `SnapshotEditService`       | Snapshot editing            |

### Procedure Types

Defined in `src/trpc.ts`:

- **`publicProcedure`** - No auth required. Has Sentry tracing and error mapping middleware.
- **`protectedProcedure`** - Requires authenticated user with an active organization.
- **`writeProcedure`** - `protectedProcedure` that also rejects writes from the read-only demo org. Every customer-facing mutation uses this.
- **`internalProcedure`** - Requires admin role. The staff-only catalog mutations (`folders.*`, `tests.rename`, `tests.delete`) use it in place of `writeProcedure`.

Plus one domain-scoped builder: **`onboardingWriteProcedure`** (`src/routes/onboarding/onboarding-write-procedure.ts`) - `writeProcedure` with funnel analytics attached. See [Onboarding funnel analytics](#onboarding-funnel-analytics).

### Error Handling

Custom `APIError` subclasses (`NotFoundError`, `ConflictError`, `BadRequestError`, `InternalError`) are automatically mapped to tRPC error codes via middleware. Unhandled errors are logged as fatal via Sentry.

### Dependency Injection

Services are built in `src/routes/build-services.ts` via plain constructor injection - no DI framework. The `createContext` function in `src/context.ts` assembles the full tRPC context (database, auth session, services) for each request.
