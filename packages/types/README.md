# @autonoma/types

Shared Zod schemas, TypeScript types, and constants used across the Autonoma monorepo. This package is the single source of truth for data contracts - both the API and frontend import from here to keep types in sync via tRPC.

## Package Exports

The package exposes four entry points:

| Entry Point | Import Path | Contents |
|-------------|-------------|----------|
| Root | `@autonoma/types` | Re-exports everything (schemas, constants, types) |
| Schemas | `@autonoma/types/schemas` | Zod schemas and inferred TypeScript types |
| Constants | `@autonoma/types/constants` | Shared constants (timeouts, retries, platforms) |
| Recipe resolver | `@autonoma/types/scenario-recipe-resolver` | `resolveRecipePayload` / `resolveRecipeCreateGraph` - the evaluator for the recipe-token contract |

The recipe resolver is deliberately outside the root barrel: it needs `node:crypto`, and the barrel is imported by the browser bundle.

## Schemas

All schemas are defined with Zod and export both the schema object and an inferred TypeScript type.

### Core

- `PlatformSchema` / `Platform` - `"web" | "ios" | "android"`
- `TestStatusSchema` / `TestStatus` - `"pending" | "running" | "passed" | "failed" | "cancelled"`

### GitHub Integration

- `GithubInstallationSchema` - GitHub App installation records
- `GithubRepositorySchema` - Linked repositories with indexing status
- `GithubTestCaseSchema` - Test cases discovered from a repository
- `GithubRepoWithTestCasesSchema` - Repository with nested test cases
- `GitHubInstallationStatusSchema` - `"active" | "suspended" | "deleted"`
- `GitHubIndexingStatusSchema` - `"pending" | "running" | "completed" | "failed"`
- `GitHubDeploymentTriggerSchema` - `"push" | "github_action"`

### Scenarios (Environment Factory)

Webhook response schemas for the Environment Factory protocol:

- `DiscoverResponseSchema` / `UpResponseSchema` / `DownResponseSchema` - Webhook lifecycle responses
- `AuthPayloadSchema` / `AuthCookieSchema` / `AuthHeadersSchema` - Authentication payloads (cookies, headers, credentials)
- `ConfigureWebhookInputSchema` / `RemoveWebhookInputSchema` - tRPC input schemas for webhook management
- `ListScenariosInputSchema` / `ListInstancesInputSchema` - tRPC input schemas for scenario queries

### Onboarding

- `OnboardingStep` - Onboarding step constants and type
- `OnboardingStateSchema` - Tracks onboarding wizard progress
- `AgentLogEntrySchema` - Agent log entry schema for onboarding logs

### Preview Environments

- `RedeployPreviewkitAppInputSchema` - Validates an application-scoped request to rebuild or restart one preview app

### Review Verdict

- `reviewVerdictSchema` / `ReviewVerdict` - AI reviewer output classifying test failures as `"agent_error"` or `"application_bug"` with severity, evidence, and reasoning

## Types

- `Architecture` - Enum: `ios`, `android`, `web`
- `OverlayPoint` / `getStepOverlayPoints` - Extracts a step output's resolved interaction points (the click target, or a drag's start/end), tagged with their role. Shared by the UI overlay and the reviewer's screenshot annotation.
- `PreviewkitManifest` / `projectManifest` - The manifest-shaped projection (apps, services, addons) of a preview environment's stored `resolvedConfig`, parsed at read time since the merged config is the single source of truth. Returns an empty projection for an absent or unparseable config.
- `parseStringRecord` - Coerces a stored JSON object (an environment's `urls` map, an addon's outputs) into a sorted `string -> string` record, dropping non-string and empty values.
- `resolvePrimaryUrl` / `resolveSdkAppUrl` / `resolveDeclaredSdkAppUrl` - Derive a preview's origins from a manifest plus its URL map: the origin tests browse (the `primary` app, with fallbacks), the origin hosting the Environment Factory handler (the `sdk_implemented` app, falling back to primary), and the explicitly declared SDK origin only (no fallback, so a caller can tell an explicit answer from the fallback).

## Shared helpers

Pure functions with no Zod or Node dependencies, living here because more than one app needs them and this is the only package the browser bundle and the workers both import.

- `buildAgentHandoffLinks` / `capHandoffPrompt` / `MAX_HANDOFF_PROMPT_CHARS` (`agent-handoff-links.ts`) - the "open in Claude Code / ChatGPT / Cursor" deep-links that prefill a coding-agent brief, plus the length cap that keeps one inside GitHub's comment limit. The vendor encoding quirks (Cursor truncating at `&`, markdown link destinations breaking on `)`) live here so they are fixed once. Used by the GitHub PR comments and by the in-app failure notes.
- `isColdStartMessage` / `isColdStartStatus` / `sdkErrorStatus` (`sdk-error-signals.ts`), plus `isColdStartFailure` (`sdk-failure.ts`, the tag-native counterpart that reads a structured `SdkFailure` instead of a message string) - tell a customer SDK endpoint that answered wrongly apart from a scaled-to-zero preview that had not woken up. `@autonoma/scenario` retries on these; the UI uses the same rules to decide whether a failed validation is worth handing to a coding agent.
- `AUTONOMA_ELEVATOR_PITCH` / `ISSUE_KIND_FIX_GUIDANCE` / `describeIssueKindRouting` / `FALSE_POSITIVE_GUIDANCE` / `describeRecheckLoop` / `buildAutonomaMcpHint` (`agent-guidance.ts`) - what a coding agent has to be told about Autonoma, above all where each issue kind's fix lives (a `bug` in the repo, an `environment` issue in the preview's configuration, a `scenario` issue in the test data). The MCP server's connect-time instructions and the pull request's fix prompt both read these, because an agent handed a prompt out of a browser has no server instructions to fall back on.
- `buildAgentFixPrompt` / `MAX_DEEP_LINK_PROMPT_CHARS` (`agent-handoff-prompt.ts`) - the paste-ready brief the PR fix page hands a coding agent, rebuilt in the browser from whichever issues the reader kept. `full` carries the run's whole account of itself (flows, report prose, code snippets, covering tests, signed media); `link` is the condensed variant a deep-link URL can hold.
- `buildPrPageUrl` / `buildPrFixUrl` / `buildAnalysisIssueUrl` / `buildAnalysisFindingUrl` (`app-links.ts`) - the in-app URL shapes for a pull request's analysis surfaces.

## Usage

```ts
// Import schemas for validation
import { PlatformSchema, type Platform } from "@autonoma/types";

const platform = PlatformSchema.parse(input); // throws on invalid

// Import from sub-paths
import { TestStatusSchema } from "@autonoma/types/schemas";
import { DEFAULT_TIMEOUT_MS } from "@autonoma/types/constants";

// Use in tRPC routers (API side)
import { ConfigureWebhookInputSchema } from "@autonoma/types";

const router = t.router({
  configureWebhook: protectedProcedure
    .input(ConfigureWebhookInputSchema)
    .mutation(({ input }) => { /* ... */ }),
});

// Use inferred types (frontend or backend)
import type { ReviewVerdict, AuthPayload } from "@autonoma/types";
```

## Architecture Notes

- **Zod-first** - Every schema is a Zod object. TypeScript types are inferred with `z.infer`, never hand-written.
- **Shared across tRPC boundary** - The API uses these schemas for input validation; the frontend gets type safety for free through tRPC's type inference. Never manually define API types on the frontend.
- **No runtime dependencies beyond Zod** - This package is intentionally lightweight. The one module that reaches for a Node built-in, `scenario-recipe-resolver`, is reachable only through its own subpath so the root barrel stays browser-safe.
- **ESM only** - No CommonJS. All imports use bare specifiers without file extensions.
