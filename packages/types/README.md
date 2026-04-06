# @autonoma/types

Shared Zod schemas, TypeScript types, and constants used across the Autonoma monorepo. This package is the single source of truth for data contracts - both the API and frontend import from here to keep types in sync via tRPC.

## Package Exports

The package exposes three entry points:

| Entry Point | Import Path | Contents |
|-------------|-------------|----------|
| Root | `@autonoma/types` | Re-exports everything (schemas, constants, types) |
| Schemas | `@autonoma/types/schemas` | Zod schemas and inferred TypeScript types |
| Constants | `@autonoma/types/constants` | Shared constants (timeouts, retries, platforms) |

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
- `DiscoverInputSchema` / `ListScenariosInputSchema` / `ListInstancesInputSchema` - tRPC input schemas for scenario queries

### Onboarding

- `OnboardingStep` - Onboarding step constants and type
- `OnboardingStateSchema` - Tracks onboarding wizard progress
- `AgentLogEntrySchema` - Agent log entry schema for onboarding logs

### Review Verdict

- `reviewVerdictSchema` / `ReviewVerdict` - AI reviewer output classifying test failures as `"agent_error"` or `"application_bug"` with severity, evidence, and reasoning

## Types

- `Architecture` - Enum: `ios`, `android`, `web`

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
- **No runtime dependencies beyond Zod** - This package is intentionally lightweight.
- **ESM only** - No CommonJS. All imports use bare specifiers without file extensions.
