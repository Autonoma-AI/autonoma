# Autonoma AI - Agentic End-to-End Testing Platform

## Project Overview

Autonoma AI is an agentic end-to-end testing platform. Users create and run automated tests for web, iOS, and Android applications using natural language. The system executes tests on real devices/emulators via Playwright (web) and Appium (mobile), with AI models handling element selection, assertions, self-healing, and agentic decision-making.

The platform is deployed on Kubernetes. Tests are distributed across device-hosting machines with Redis-based device locking for exclusive access.

## Monorepo Structure

```
root/
├── apps/
│   ├── api/              # Hono + tRPC API server (port 4000)
│   │   └── src/
│   │       ├── routers/       # Thin tRPC routers (wiring only)
│   │       └── controllers/   # Business logic (one directory per router)
│   ├── docs/             # Astro Starlight documentation site
│   ├── ui/               # Vite + React 19 SPA (port 3000)
│   ├── engine-web/       # Playwright-based web test execution
│   ├── engine-mobile/    # Appium-based mobile test execution (iOS + Android)
│   └── jobs/
│       ├── reviewer/     # Post-test AI validation using video recordings
│       └── notifier/     # SNS/SQS → Slack/email notifications
├── packages/
│   ├── ai/               # AI primitives: model registry, visual AI, point/object detection
│   ├── db/               # Prisma schema + generated client (PostgreSQL)
│   ├── types/            # Shared Zod schemas, TypeScript types, constants
│   ├── engine/           # Shared engine: execution agent, commands, driver interfaces
│   ├── device-lock/      # Redis-based distributed device locking
│   ├── blacklight/          # Shared UI component library (Radix + Tailwind + CVA)
│   └── utils/            # Logger (Sentry), storage, image, k8s helpers
├── docker/               # Dockerfiles for all services
└── deployment/           # K8s manifests (future)
```

## Development Commands

```bash
pnpm install             # install all dependencies
pnpm db:generate         # generate Prisma client
pnpm build               # build everything (Turborepo)
pnpm typecheck           # tsc --noEmit on all packages
pnpm lint                # eslint on all packages
pnpm test                # vitest on all packages
pnpm dev                 # starts web (3000) and api (4000) concurrently
pnpm db:migrate          # run Prisma migrations
```

### Adding Dependencies

**Always check `pnpm-workspace.yaml` catalog first before adding a dependency.** The catalog defines pinned versions for shared dependencies. When adding a dependency:

1. Check if it already exists in the `catalog:` section of `pnpm-workspace.yaml`.
2. If it does, use `catalog:` as the version specifier in `package.json` instead of a hardcoded version (e.g., `"zod": "catalog:"`).
3. If it doesn't exist in the catalog, consider whether it should be added there (shared across multiple packages) or pinned locally.

```jsonc
// GOOD - uses catalog version
"dependencies": {
  "zod": "catalog:"
}

// BAD - hardcodes version when catalog exists
"dependencies": {
  "zod": "^3.23.0"
}
```

## Code Conventions

### Module System

**ESM-only everywhere.** Every `package.json` has `"type": "module"`. No CommonJS. Non-negotiable.

**Never use `.js` extensions in imports.** All imports must use bare specifiers without file extensions. TypeScript and the bundler resolve modules automatically.

```ts
// GOOD
import { foo } from "./foo";
import { bar } from "@autonoma/types";

// BAD - never add .js to imports
import { foo } from "./foo.js";
```

### TypeScript - Strictest Configuration

All strict flags enabled. Every package extends `tsconfig.base.json`. This includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, etc.

### No `as` Casts

**Never use `as` type assertions.** They silently lie to the compiler and bite later. When TypeScript can't infer a type, choose one of:

- **Reshape the source type or function signature** so the value already has the right type (preferred).
- **Add an explicit type annotation** on a variable / parameter / return so inference flows correctly.
- **Validate at the boundary with Zod** (`schema.parse(value)`) when the data comes from outside the type system - HTTP requests, JSON files, env vars, third-party SDK responses. The Zod parse returns a properly typed value; no cast needed.
- **Use a user-defined type guard** (`function isFoo(x: unknown): x is Foo { ... }`) for runtime discrimination.

The only acceptable assertion is `as const` (for literal-type narrowing). `as unknown as T`, `as Record<string, unknown>`, `as any` are all forbidden - they always indicate the wrong abstraction.

```ts
// BAD
applyTags(ctx as Record<string, unknown>);
const user = response.data as User;

// GOOD
function applyTags(ctx: ObservabilityContext): void { ... }   // typed parameter, no cast at call site
const user = UserSchema.parse(response.data);                  // zod-validated at the boundary
```

### Classes vs Functions

- **Needs state or dependencies?** Class with constructor injection.
- **Pure logic with no state?** Function file.
- In practice, almost everything is a class.

### Dependency Injection

Plain constructor injection. No DI framework.

```ts
class StepExecutor {
  constructor(
    private readonly engine: Engine,
    private readonly logger: BackendLogger,
  ) {}
}
```

### One Export per File

A file exports exactly one thing. The exported function/class tells the story top-to-bottom. Private helpers follow in call order.

### Database Transactions

**Wrap sequential DB queries in a Prisma `$transaction` when they must be consistent.** If a service method reads then writes (or writes multiple tables), use `db.$transaction(async (tx) => { ... })` and pass `tx` to all queries inside.

```ts
async createGeneration(userId: string, orgId: string, appId: string) {
  return await this.db.$transaction(async (tx) => {
    const app = await tx.application.findFirst({ where: { id: appId, organizationId: orgId } });
    if (app == null) throw new Error("Application not found");

    const generation = await tx.applicationGeneration.create({ data: { ... } });
    await tx.onboardingState.upsert({ where: { applicationId: appId }, ... });

    return { id: generation.id };
  });
}
```

### Custom Error Hierarchy

```
AutonomaError (base)
├── TestError          - test execution failures
├── DriverError        - Appium/Playwright driver failures
├── PreconditionError  - setup/precondition failures
├── VerificationError  - assertion failures
└── ThirdPartyError    - external service failures
```

### Prefer `undefined` over `null`

**Always prefer `undefined` over `null`.** Use optional properties (`?`) instead of `| null` types. Never initialize to `null`.

```ts
// GOOD
private whatever?: string

// BAD - never do this
private whatever: string | null = null
```

This applies to class properties, function parameters, return types, and object shapes. Use `undefined` as the absence-of-value sentinel everywhere.

### Nullish Checks

Always `??`, never `||`. Always `!= null` / `== null`, never truthy/falsy checks. The `!= null` check covers both `null` and `undefined`, which is exactly what we want.

```ts
// GOOD
const timeout = config.timeout ?? 3000;
if (element != null) { ... }

// BAD - truthy/falsy checks have unexpected behavior with 0, "", false
if (element) { ... }
if (!element) { ... }
```

### Avoid `let` + Conditional Assignment

Extract a function with early returns instead.

### Early Returns and Reduced Nesting

**Always prefer early returns to reduce nesting.** If a function has deeply nested `if` blocks, extract the inner logic into a separate function with early returns. Flat code is readable code.

```ts
// GOOD
function processOrder(order: Order): Result {
  if (order.status === "cancelled") throw new OrderCancelledError();
  if (order.items.length === 0) throw new EmptyOrderError();

  return calculateTotal(order);
}

// BAD - deeply nested
function processOrder(order: Order): Result {
  if (order.status !== "cancelled") {
    if (order.items.length > 0) {
      return calculateTotal(order);
    }
  }
  // ...
}
```

### No Complex Destructuring or Spread

**Never over-use spread operators or conditional spreads.** If constructing an object requires multiple `...` spreads or ternary-based spreads, build the object explicitly instead. Complex destructuring is extremely hard to follow.

```ts
// BAD - impossible to follow
return {
  ...baseConfig,
  ...((isAdmin) ? { permissions: allPermissions } : { permissions: readOnly }),
  ...overrides,
};

// GOOD - explicit and readable
const permissions = isAdmin ? allPermissions : readOnly;
return {
  name: baseConfig.name,
  timeout: baseConfig.timeout,
  permissions,
  retries: overrides.retries ?? baseConfig.retries,
};
```

### Extract Complex Conditions

**If a condition is not immediately obvious, extract it into a descriptively named variable.** Future readers (including yourself) should understand what the condition checks without parsing boolean logic.

```ts
// GOOD
const isTrialExpired = subscription.status === "trial" && subscription.endsAt < now;
const hasNoPaymentMethod = user.paymentMethods.length === 0;
if (isTrialExpired && hasNoPaymentMethod) { ... }

// BAD - what does this check?
if (subscription.status === "trial" && subscription.endsAt < now && user.paymentMethods.length === 0) { ... }
```

### Never Swallow Errors in Empty Catches

**Never write an empty `catch` block.** A bare `catch {}` (or a catch whose only content is a comment) silently swallows every error and makes future debugging nearly impossible - when the surrounding logic mysteriously stops working, there is no breadcrumb to follow. Every catch must at minimum log the error so it shows up in Sentry and in local logs.

The minimum acceptable catch logs the error at an appropriate level and includes enough context to identify which call site swallowed it. `debug` is fine for expected/benign failures (feature detection, optional cleanup); `warn` or `error` for anything the operator might need to act on. This applies to `try/catch`, `.catch(handler)`, and async iterator catches alike.

```ts
// BAD - silently swallows
try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.name;
} catch {
    return undefined;
}

// BAD - comment is not a log
try {
    riskyThing();
} catch {
    // ignore, not critical
}

// GOOD - logs with enough context to find later
try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.name;
} catch (err) {
    logger.debug("Failed to parse package.json, falling back", { pkgPath, err });
    return undefined;
}

// GOOD - promise catch with context
await rm(planDir, { recursive: true }).catch((err) => {
    logger.warn("Failed to clean up plan dir", { planDir, err });
});
```

The one narrow exception is best-effort cleanup in test code, where a console-level log (`console.warn`) is acceptable when the package logger is not available.

### Logging - Sentry

**Always use Sentry for logging and error tracking.** All backend services must initialize Sentry and use it for:
- Error capture and reporting
- Performance monitoring / tracing
- Structured logging context

Use `@sentry/node` in all backend apps and packages. Use `@sentry/react` in the frontend.

**Overlog > underlog.** Every new class and every function file must have logging. When in doubt, add a log. Key moments to log:

- Service startup and configuration
- Incoming requests and their resolution (success/failure)
- External API calls (start, success, failure)
- State transitions (agent steps, job status changes)
- Resource acquisition/release (device locks, browser sessions)
- Business-critical operations (test started, test finished, assertion result)
- **Every public method entry** with relevant parameters
- **Every method exit** with relevant results or status

Use structured context (Sentry breadcrumbs, tags, extra data) so logs are searchable and traceable. Avoid logging sensitive data (credentials, tokens).

#### Classes - Instance Logger

**Every class must have a `private readonly logger` instance**, created in the constructor as a child of the root logger with the class name and any identifying context. Log at the top of every public method and at key decision points.

```ts
import { type Logger, logger } from "@autonoma/logger";

export class TestSuiteUpdater {
    private readonly logger: Logger;

    constructor(private readonly snapshotId: string) {
        this.logger = logger.child({ name: this.constructor.name, snapshotId });
    }

    public async apply(change: TestSuiteChange) {
        this.logger.info("Applying test suite change", { type: change.constructor.name });
        // ... do work ...
        this.logger.info("Finished applying change");
    }

    public async finalize() {
        this.logger.info("Finalizing snapshot");
        // ... do work ...
        this.logger.info("Snapshot finalized and activated");
    }
}
```

#### Reusable Functions Called From Classes

If a reusable function is called from a class method, **accept a `Logger` parameter** so the caller can pass its instance logger, preserving the logging context chain.

```ts
import type { Logger } from "@autonoma/logger";

export function computeChanges(branchId: string, logger: Logger) {
    logger.info("Computing changes", { branchId });
    // ... do work ...
    logger.info("Changes computed", { count: changes.length });
    return changes;
}
```

#### Standalone Function Files

If a file exports a collection of independently useful functions (not called from a single class), **import the root logger and create a child logger per function** with the function name.

```ts
import { logger as rootLogger } from "@autonoma/logger";

export function syncDevices(deviceIds: string[]) {
    const logger = rootLogger.child({ name: "syncDevices" });
    logger.info("Syncing devices", { count: deviceIds.length });
    // ... do work ...
    logger.info("Devices synced");
}

export function pruneStaleEntries(cutoffDate: Date) {
    const logger = rootLogger.child({ name: "pruneStaleEntries" });
    logger.info("Pruning stale entries", { cutoffDate });
    // ... do work ...
    logger.info("Pruning complete", { removed: count });
}
```

### Frontend — See the `ui-conventions` skill

The UI app conventions are defined in the `ui-conventions` skill, which is auto-loaded when editing files under `apps/ui/`. It covers React development, data fetching, mutations, route loaders, analytics, and the design system.

### Backend Analytics - PostHog

**Use `@autonoma/analytics` for server-side event tracking.** The `PostHogAnalytics` singleton (`packages/analytics`) wraps `posthog-node` with Sentry trace linking. It no-ops when not initialized (dev/test).

```ts
import { analytics } from "@autonoma/analytics";

analytics.capture(userId, "test_generation.completed", {
    generationId,
    applicationId,
    status: "success",
});
```

- `distinctId` is always explicit (user ID from auth context or job payload)
- Sentry trace ID is automatically attached to events via `$sentry_trace_id`
- Initialized in `apps/api/src/index.ts` with `POSTHOG_KEY` env var

### Frontend UI - `@autonoma/blacklight`

**Always use components from `@autonoma/blacklight` when building frontend interfaces.** This is a shared component library built on Radix UI + Tailwind CSS v4 + CVA. See `.claude/skills/design.md` for the full design system reference and `.claude/skills/frontend-design.md` for high-quality frontend design guidelines.

- Import components: `import { Button, Card, Input } from "@autonoma/blacklight";`
- Import styles in app entry: `import "@autonoma/blacklight/styles.css";`
- Use `cn()` from `@autonoma/blacklight` for className merging
- Use CVA (class-variance-authority) for component variants
- Use Lucide React for icons
- Path alias `@/*` maps to `packages/blacklight/src/*` inside the package
- Components follow shadcn/ui patterns (Radix primitives + Tailwind styling)
- **Never use `text-text-tertiary`.** This text color token is deprecated and no longer available. Use `text-text-secondary` as the lightest text tone instead, in all new and edited UI code.

For React development patterns, data fetching, mutations, and analytics, see the `ui-conventions` skill.

### Testing

- **Vitest** everywhere. Every package has it installed and a test script.
- **Prefer integration tests** over unit tests.
- **Never mock the database.** Use Testcontainers with a real PostgreSQL container for all tests that need a database. Use the `@autonoma/integration-test` package's `IntegrationHarness` pattern and `integrationTestSuite` helper.
- Use Testcontainers for Redis/PostgreSQL tests.
- Test files: `*.test.ts` in `test/` directories mirroring `src/`.
- Only test what makes sense - don't test trivial getters.
- **Test behavior, not structure.** Don't write tests that only verify a function was called, a mock received certain arguments, or a property exists - the typechecker handles structural correctness. Tests should verify observable outcomes: return values, DB state changes, error handling, side effects. If renaming an internal function or reordering calls would break a test without changing any behavior, that test is structural and should not exist.

## Architecture Notes

### tRPC - Type-Safe API

Types flow through tRPC from API to frontend. Never manually define API response types on the frontend. Zod schemas in `packages/types` are used by both sides.

### Adding a new tRPC route

1. Define Zod schemas in `packages/types/src/schemas/`.
2. Create a controller file in `apps/api/src/controllers/<routerName>/<procedureName>.ts`.
3. Create (or update) the router file in `apps/api/src/routers/` to wire the procedure to the controller.
4. Add the router to `appRouter` in `apps/api/src/router.ts` (if new router).
5. Use `useSuspenseQuery(trpc.routerName.procedureName.queryOptions())` or `useAPIMutation(trpc.routerName.procedureName.mutationOptions())` in the frontend.

### Adding a new page

1. Create a route file in `apps/ui/src/routes/`.
2. TanStack Router plugin auto-generates the route tree.

### Database schema changes

1. Edit `packages/db/prisma/schema.prisma`.
2. Run `pnpm db:migrate`.
3. Run `pnpm db:generate`.

### Device Locking

Redis-based distributed locking in `@autonoma/device-lock`. Supports "soft" (job) and "hard" (creation) locks with TTL, health checking, and event publishing.

---

## Execution Agent - See the `execution-agent` skill

The execution agent and command system live in the `@autonoma/engine` package and are documented in the `execution-agent` skill, which is auto-loaded when editing files under `packages/engine/`. It covers the agent loop, commands, driver interfaces, the runner, and how to add a command or extend to a new platform. For the full file tree and command table, see `packages/engine/README.md`.

---

## AI Package - See the `ai-utils` skill

The `@autonoma/ai` package provides the AI primitives used across the platform: the reusable agent abstraction, model registry, structured output generation, visual checkers, and point/object detection. These are documented in the `ai-utils` skill, which is auto-loaded when editing files under `packages/ai/`. For the live model list and usage examples, see `packages/ai/README.md`.

---

## Engine Apps

### `apps/engine-web/`

Playwright-based web test execution. Implements the driver interfaces from `@autonoma/execution-agent`:
- Playwright page methods for `ScreenDriver`, `MouseDriver`, `KeyboardDriver`, `NavigationDriver`
- Network idle detection for `ApplicationDriver.waitUntilStable()`
- Playwright native recording or FFmpeg for `VideoRecorder`
- Page screenshot polling for `ImageStream`

### `apps/engine-mobile/`

Appium-based mobile test execution (iOS + Android). Implements the same driver interfaces:
- Appium/WebDriver methods for all drivers
- Device-native recording for `VideoRecorder` (adb screenrecord for Android)
- Uses `@autonoma/device-lock` for Redis-based device allocation
- Deep links / app intents for `NavigationDriver`

**Both engines are completely separate Docker images.** They share all logic from `@autonoma/execution-agent` and `@autonoma/ai` but never share a Docker image.

---

## Key Principles

1. **ESM everywhere.** No CommonJS.
2. **Types flow through tRPC.** No manual API types on frontend.
3. **Shared validation.** Zod schemas in `types` used by both API and frontend.
4. **Static frontend.** No SSR. React SPA compiled to static files.
5. **Engines are separate images.** Web and mobile never share a Docker image.
6. **Jobs are separate images.** Each job type has its own Dockerfile.
7. **One concern per package.** db = schema, types = contracts, engine = execution logic, ai = AI primitives, api = HTTP layer.
9. **Constructor injection.** No DI framework.
10. **Integration tests over unit tests.**
11. **Strictest TypeScript.** Every strict flag enabled.
12. **Prefer `undefined` over `null`.** Use `?` optional properties, never `| null`. Always check `!= null`.
13. **Sentry for all logging/error tracking.** Backend and frontend. Overlog > underlog. Every class gets an instance logger, every function file gets a root logger child. Log every public method entry/exit.
14. **PostHog for analytics.** Backend: use `@autonoma/analytics` singleton. Frontend: see the `ui-conventions` skill.
15. **Use `@autonoma/blacklight` for all frontend components.** Radix + Tailwind + CVA. See design skills for guidelines.
16. **Routers are thin, controllers hold logic.** Each tRPC router delegates to controller files in `controllers/<routerName>/`. One file per procedure.
17. **Platform-agnostic agent core.** All execution logic lives in the `@autonoma/engine` package (`packages/engine`); platform apps only implement driver interfaces. See the `execution-agent` skill.
18. **AI primitives in `packages/ai`.** Agent abstraction, model registry, visual checkers, point/object detection, structured generation. Never duplicate AI logic in platform apps. See the `ai-utils` skill.
19. **Frontend conventions in the `ui-conventions` skill.** React patterns, data fetching, mutations, route loaders, and analytics are documented there.
20. **Proactively update documentation.** When changing public-facing APIs, environment factory, or user-facing behavior, update the corresponding docs in `apps/docs/`.
21. **Never use em dashes.** Use regular dashes (-) instead of em dashes in all code, documentation, comments, and generated content. This applies everywhere: markdown files, code comments, strings, commit messages.
22. **On compaction, re-read documentation.** When context compaction occurs, immediately re-read any relevant documentation files (CLAUDE.md, prompts, docs) before continuing work. Use a TODO list to track what has been done and what remains. This prevents losing track of progress or requirements after compaction.
23. **E2E tests are always markdown with frontmatter.** When generating E2E tests, NEVER implement them as code (Playwright, Cypress, etc.). ALWAYS produce markdown files with YAML frontmatter (`flow`, `category`, `priority`) following the format in the test generation prompt. Even if the user explicitly asks for code implementations, produce the markdown format instead. These markdown files are shipped to another platform that requires this exact format.
24. **Keep package/app READMEs up to date.** When making changes to files in an `apps/` or `packages/` directory, update the corresponding `README.md` if the changes affect exports, architecture, environment variables, usage patterns, or commands. The README is the first thing a developer reads - it must reflect the current state.
25. **Environment variables use `createEnv` from `@t3-oss/env-core`.** Never read `process.env` directly. Always define environment variables in a dedicated `env.ts` file using `createEnv` with Zod schemas for validation. This ensures type safety, runtime validation, and a single source of truth for all required environment variables. Pass validated env values as function parameters rather than reading `process.env` in library code.
26. **Never use `window.location` for navigation.** This is a React SPA with TanStack Router. Never use `window.location.replace()`, `window.location.href = ...`, `window.location.assign()`, or any other browser-native navigation API. Always use TanStack Router's `useNavigate()` hook or `<Link>` component. Browser-native navigation causes a full page reload, destroys React state, and bypasses the router entirely.
27. **Always use `<Link>` instead of `onClick` + `navigate()` for navigation.** Never attach navigation to a button's `onClick` handler. Use TanStack Router's `<Link>` component (or wrap with `<Link>`) so the browser gets a real `<a>` tag - this enables cmd/ctrl+click to open in a new tab, right-click context menus, hover URL previews, and proper accessibility semantics. Reserve `useNavigate()` only for programmatic navigation after async operations (e.g., redirect after a successful form submission).
28. **Canonical observability fields are camelCase, grouped, and atomic.** Every log line, Sentry tag, and PostHog property should carry the same canonical IDs. The schema lives in `packages/logger/src/observability-context.ts` (`ObservabilityContextSchema`) and is organized into atomic groups: `temporal`, `organization`, `application`, `branch`, `snapshot`, `refinementLoop`, `refinementIteration`, `testCase`, `testGeneration`, `run`, `job`. Each group is optional but its required fields are mandatory - you can't have a `refinementLoop` group with `loopId` but no `triggeredBy`. At an entry point (Temporal activity interceptor, job entry, request handler) wrap the work in `withObservabilityContext({ snapshot: { snapshotId }, ... })`; downstream code calls `extendObservabilityContext({ branch: { branchId } })` as more groups become known. Inside that scope, every `logger.*` call automatically carries those fields, flattened to top-level keys at emit (snapshotId, branchId, workflowId, ...) - do **not** thread IDs through `logger.child({ snapshotId, ... })`. The `extra:` bag is the only place for non-canonical fields: `logger.info("...", { extra: { count: 42 } })`. Add new fields to the appropriate group (or create a new group) before using them; never invent ad-hoc keys at call sites or use `snake_case` field names.

---

## Documentation Site (`apps/docs`)

The documentation site is built with Astro Starlight and deployed to S3 + CloudFront at `docs.autonoma.app`.

### When to Update Docs

**Proactively update documentation when making changes that affect:**
- Public-facing APIs or SDK interfaces
- Environment Factory implementations or configuration
- New framework integrations or examples
- Command specifications or driver interfaces that users interact with
- Any breaking changes to user-facing behavior

### How to Update Docs

1. Documentation content lives in `apps/docs/src/content/docs/` as Markdown (`.md`) or MDX (`.mdx`) files.
2. The sidebar is configured in `apps/docs/astro.config.mjs` under the `sidebar` array. Add new entries when creating new pages.
3. Run `pnpm docs` to preview changes at `localhost:4321`.
4. The `llms.txt` file is auto-generated at build time by the `starlight-llms-txt` plugin. No manual maintenance needed.

### Documentation Structure

```
apps/docs/src/content/docs/
├── index.mdx                    # Landing page (splash template)
├── getting-started/
│   └── index.md                 # Quick start guide
├── guides/
│   └── environment-factory.md   # Environment Factory Guide (generic)
└── examples/
    └── nextjs.md                # Next.js Implementation Example
```

### Adding a New Documentation Page

1. Create a new `.md` or `.mdx` file in the appropriate directory under `apps/docs/src/content/docs/`.
2. Add frontmatter with at least `title` and `description`.
3. Add the page to the sidebar in `apps/docs/astro.config.mjs`.
4. Docs deploy automatically on push to `main` when `apps/docs/**` files change.
