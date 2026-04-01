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

For React development patterns, data fetching, mutations, and analytics, see the `ui-conventions` skill.

### Testing

- **Vitest** everywhere. Every package has it installed and a test script.
- **Prefer integration tests** over unit tests.
- **Never mock the database.** Use Testcontainers with a real PostgreSQL container for all tests that need a database. Use the `@autonoma/integration-test` package's `IntegrationHarness` pattern and `integrationTestSuite` helper.
- Use Testcontainers for Redis/PostgreSQL tests.
- Test files: `*.test.ts` in `test/` directories mirroring `src/`.
- Only test what makes sense - don't test trivial getters.

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

## Execution Agent (`packages/engine/execution-agent`)

The execution agent is the core of test execution. It is a **generic, platform-agnostic AI agent** that web and mobile engines extend. Everything is parameterized with `TSpec` (command spec) and `TContext` (driver context), so the same agent core works for both Playwright (web) and Appium (mobile).

### Directory Structure

```
packages/engine/execution-agent/src/
├── index.ts                        # Package re-exports
├── agent/                          # Core AI agent loop
│   ├── execution-agent.ts          # Main agent class - the agentic loop
│   ├── execution-agent-factory.ts  # Abstract factory for building agents
│   ├── execution-result.ts         # Result types (GeneratedStep, ExecutionResult)
│   ├── test-case.ts                # BaseTestCase interface
│   ├── system-prompt.ts/.md        # Agent system prompt
│   ├── tools/                      # LLM tools
│   │   ├── build-command-tool.ts   # Wraps AgentCommand as an AI SDK tool
│   │   ├── execution-finished-tool.ts  # Ends the test
│   │   ├── ask-user-tool.ts        # Asks human for clarification
│   │   └── wait-tool.ts            # Sleeps for N seconds
│   └── components/
│       └── wait-planner.ts         # Generates wait conditions between steps
├── agent-commands/                  # Command abstraction system
│   ├── agent-command.ts            # Abstract AgentCommand<TSpec, TContext>
│   ├── command-spec.ts             # CommandSpec type (interaction, modelInput, params, output)
│   ├── command-registry.ts         # Registry of available commands
│   └── commands/                   # Built-in commands
│       ├── click/                  # AI-powered element clicking
│       ├── type/                   # Find element + type text
│       ├── scroll/                 # Scroll up/down
│       ├── assert/                 # Visual assertion checking
│       └── wait-until/             # Wait for visual condition (not exposed to LLM)
├── context/                        # Platform driver interfaces
│   ├── drivers/
│   │   ├── screen.driver.ts        # screenshot(), getResolution()
│   │   ├── mouse.driver.ts         # click(x, y), scroll(direction)
│   │   ├── keyboard.driver.ts      # type(text), press(key)
│   │   ├── application.driver.ts   # waitUntilStable()
│   │   └── navigation.driver.ts    # navigate(url), getCurrentUrl()
│   ├── installer.ts                # Abstract Installer - builds context from test case
│   ├── image-stream.ts             # Live frame streaming interface
│   ├── video-recorder.ts           # Abstract VideoRecorder with state machine
│   └── preparation-script.ts       # Pre-test setup scripts interface
└── runner/                          # Orchestration layer
    ├── execution-agent-runner.ts   # Main runner - ties installer + factory + recording
    ├── local-runner.ts             # Local dev runner (loads markdown test files)
    ├── load-test-case.ts           # Parses markdown frontmatter into test cases
    ├── artifacts.ts                # Writes screenshots, steps, conversation, video to disk
    └── events.ts                   # Event hooks (beforeStep, afterStep, frame)
```

### How the Agent Works

The `ExecutionAgent` wraps the Vercel AI SDK's `ToolLoopAgent`. Each iteration:

1. **Screenshot** - captures current screen state
2. **Inject context** - packages screenshot + instruction + steps-so-far into a user message
3. **LLM decides** - model picks which tool/command to call (or finishes)
4. **Command executes** - the chosen command runs against platform drivers
5. **Record step** - saves the step with before/after metadata
6. **Wait planning** - asynchronously generates a wait condition for replay
7. **Loop or stop** - continues until `execution-finished` is called or `maxSteps` (default 50) is reached

**Loop detection**: If the model's reasoning mentions "loop", "stuck", "no progress", or "repeating" in a `success: false` finish, it's flagged as a loop.

### CommandSpec - The Command Type System

Every command is defined by a `CommandSpec`:

```ts
interface CommandSpec {
  interaction: string      // command name (e.g., "click")
  modelInput: object       // what the LLM provides (natural language description)
  params: object           // what gets stored for replay
  output: { outcome: string } // what the command returns
}
```

`AgentCommand<TSpec, TContext>` is the abstract base class all commands extend. Key members:
- `interaction` - command name (becomes the LLM tool name)
- `inputSchema` / `paramsSchema` - Zod schemas
- `description()` - shown to the AI
- `execute(input, context)` - performs the action
- `exposeTool()` - whether to register as an LLM tool (default `true`)

### Built-in Commands

| Command | Exposed to LLM | What it does |
|---------|----------------|--------------|
| **click** | Yes | Takes a natural-language element description, uses `PointDetector` AI to locate pixel coordinates, calls `mouse.click(x, y)` |
| **type** | Yes | Takes element description + text. Uses `PointDetector` to find element, clicks it, then calls `keyboard.type(text)` |
| **assert** | Yes | Takes an instruction (can contain multiple assertions). Uses `AssertionSplitter` to decompose, takes one screenshot, runs `AssertChecker` on all assertions in parallel |
| **scroll** | Yes | Takes `"up"` or `"down"`, calls `mouse.scroll(direction)` |
| **wait-until** | No | Polls a visual condition every 1s up to timeout using `VisualConditionChecker`. Auto-generated by `WaitPlanner`, not callable by the LLM |

### LLM Tools (non-command)

| Tool | Purpose |
|------|---------|
| **wait** | Sleeps for N seconds. Not recorded as a step. For loading screens |
| **ask-user** | Sends questions to a human via WebSocket. Pauses until answered |
| **execution-finished** | Called by the model to end the test. Takes `{ success, reasoning }` |

### Driver Interfaces

Platform-specific apps (`engine-web`, `engine-mobile`) implement these interfaces:

- **`ScreenDriver`** - `screenshot()`, `getResolution()`
- **`MouseDriver`** - `click(x, y)`, `scroll(direction)`
- **`KeyboardDriver`** - `type(text)`, `press(key)`
- **`ApplicationDriver`** - `waitUntilStable()`
- **`NavigationDriver`** - `navigate(url)`, `getCurrentUrl()`

### Runner & Artifacts

`ExecutionAgentRunner` orchestrates a full test run:
1. Calls `Installer.install()` to build platform context (browser/device + drivers)
2. Registers frame handler for live streaming
3. Wraps `agent.generate()` in `VideoRecorder.withRecording()`
4. Returns `{ result, videoPath }`

`LocalRunner` extends this for local development - loads test cases from markdown files and saves artifacts:

```
artifacts/{timestamp}-{testName}/
├── screenshots/step-0-before.jpeg, step-0-after.jpeg, ...
├── steps.json          # Array of CommandExecutionOutput
├── conversation.json   # Sanitized AI turn log
├── instruction.txt     # The test prompt
└── video.{ext}         # Recording
```

### Result Types

- **`GeneratedStep<TSpec>`** - one step: execution output, wait condition, before/after metadata (screenshots)
- **`ExecutionResult<TSpec>`** - full result: steps, success, finishReason (`"success" | "max_steps" | "error"`), reasoning, conversation
- **`LeanExecutionResult<TSpec>`** - network-safe version stripped of large image buffers

### Test Cases as Markdown

Test files use gray-matter frontmatter for parameters, body for the natural language prompt:

```markdown
---
url: https://example.com
---
Navigate to the login page, enter "user@test.com" and "password123", click Sign In, and assert the dashboard is visible.
```

### Adding a New Command

1. Define a `CommandSpec` type for the command's interaction, input, params, and output.
2. Create a class extending `AgentCommand<YourSpec, YourContext>`.
3. Implement `interaction`, `inputSchema`, `paramsSchema`, `description()`, `execute()`.
4. Register it in the `CommandRegistry` via `registry.addCommand(new YourCommand(...))`.

### Extending for a New Platform

1. Implement all driver interfaces (`ScreenDriver`, `MouseDriver`, etc.) using your platform's SDK.
2. Create an `Installer` subclass that builds the context (drivers + image stream + video recorder).
3. Create an `ExecutionAgentFactory` subclass that calls `prepareContext()` for platform-specific setup.
4. Create a runner entry point that wires everything together.

---

## AI Package (`packages/ai`)

The `@autonoma/ai` package provides all AI primitives used by the execution agent.

### Directory Structure

```
packages/ai/src/
├── index.ts                          # Package re-exports
├── registry/                         # Model registry & configuration
│   ├── model-registry.ts             # Core ModelRegistry - manages LLM instances
│   ├── model-entries.ts              # Model definitions & pricing
│   ├── providers.ts                  # LLM provider singletons (Groq, Google, OpenRouter)
│   ├── options.ts                    # ModelOptions, reasoning effort levels
│   ├── costs.ts                      # Cost calculation functions
│   ├── usage.ts                      # Token usage tracking
│   └── monitoring.ts                 # Logging middleware & telemetry
├── visual/                           # Visual AI primitives
│   ├── visual-condition-checker.ts   # Check if a condition is met on a screenshot
│   ├── assert-checker.ts            # Validate test assertions (extends VisualConditionChecker)
│   └── visual-chooser.ts            # Pick which UI element matches an instruction
├── object/                           # Structured output generation
│   ├── object-generator.ts          # Generate structured JSON from vision/text models
│   ├── retry.ts                     # Retry with exponential backoff
│   ├── user-messages.ts             # Build multimodal messages (text + images + video)
│   └── video/
│       ├── video-processor.ts       # Upload videos to Google GenAI Files API
│       └── video-input.ts           # Video input types & model support
├── text/
│   └── assertion-splitter.ts        # Split compound assertions into atomic ones
├── freestyle/                        # Point & object detection
│   ├── point/
│   │   ├── point-detector.ts        # Abstract PointDetector base
│   │   ├── gemini-computer-use-point-detector.ts  # Gemini computer-use API
│   │   ├── moondream-point-detector.ts            # Moondream VL model
│   │   └── object-point-detector.ts               # Adapter: ObjectDetector -> PointDetector
│   ├── object/
│   │   ├── object-detector.ts       # Abstract ObjectDetector base
│   │   └── gemini-object-detector.ts # Gemini-based bounding box detection
│   └── resolution-fallback.ts       # Coordinate resolution management
└── evals/                            # AI evaluation framework (Vitest integration)
    ├── Evaluation.ts                 # Base evaluation class
    ├── model-evaluation.ts           # Tracks usage/cost per model
    ├── assert-condition/             # Assertion accuracy evals
    ├── freestyle-click/              # Point detection accuracy evals
    └── wait-for-instruction/         # Wait condition evals
```

### Model Registry

`ModelRegistry<TModel>` manages all LLM instances with middleware for cost tracking and monitoring.

**Current models:**
- `GEMINI_3_FLASH_PREVIEW` / `GEMINI_3_PRO_PREVIEW` (Google)
- `MINISTRAL_8B` (Mistral, via OpenRouter)
- `GPT_OSS_120B` (OpenAI OSS, via Groq or OpenRouter)

**Default model for tests and scripts:** Always use `GEMINI_3_FLASH_PREVIEW` (`gemini-3-flash-preview`) as the default model when writing tests, scripts, or any code that needs a Gemini model directly. Never use older model versions (e.g., `gemini-2.5-flash-preview-*`).

**Providers:** `groqProvider`, `googleProvider`, `openRouterProvider` - all lazy singletons.

**Reasoning effort:** `"none" | "low" | "medium" | "high"` - translated to provider-specific parameters (Groq's `reasoningEffort`, Google's `thinkingConfig.thinkingLevel`).

### Visual AI Primitives

| Class | Purpose | Input | Output |
|-------|---------|-------|--------|
| `VisualConditionChecker` | Check if a condition is met on a screenshot | Screenshot + condition text | `{ metCondition, reason }` |
| `AssertChecker` | Validate test assertions on screenshots | Screenshot + assertion text | `{ metCondition, reason }` |
| `VisualChooser` | Pick which UI element matches an instruction | Screenshot + options with bounding boxes | `{ reasoning, option }` |
| `AssertionSplitter` | Split compound assertions into atomic ones | Complex assertion text | `string[]` of individual assertions |

### Point Detection (Element Location)

Used by `click` and `type` commands to find where to interact on screen.

| Detector | How it works |
|----------|-------------|
| `GeminiComputerUsePointDetector` | Uses Gemini 2.5 computer-use with `click_at` tool. Coordinates in 0-1000 space scaled to pixels |
| `MoondreamPointDetector` | Lightweight Moondream VL model. Normalized 0-1 coordinates scaled to resolution |
| `ObjectPointDetector` | Adapter: detects bounding box via `ObjectDetector`, returns center point |

### Object Detection

`GeminiObjectDetector` uses Gemini's structured output to return bounding boxes as normalized 0-1000 coordinates with optional labels.

### ObjectGenerator

Core structured output engine used by almost everything. Features:
- Zod schema validation for structured JSON output
- Automatic retry with exponential backoff (default 5 retries)
- Multimodal input: text + images + video
- Strips null bytes from responses (PostgreSQL compatibility)
- Tool support for agentic generation workflows

### Evaluation Framework

`Evaluation<TTestCase>` integrates with Vitest for benchmarking AI accuracy:
- `ModelEvaluation` tracks token usage and cost per model
- Three eval types: assertion accuracy, click detection accuracy, wait condition accuracy
- Results saved as JSON with pass rates and per-case breakdowns

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
17. **Platform-agnostic agent core.** All execution logic lives in `packages/engine/execution-agent`. Platform apps only implement driver interfaces.
18. **AI primitives in `packages/ai`.** Model registry, visual checkers, point/object detection, structured generation. Never duplicate AI logic in platform apps.
19. **Frontend conventions in the `ui-conventions` skill.** React patterns, data fetching, mutations, route loaders, and analytics are documented there.
20. **Proactively update documentation.** When changing public-facing APIs, environment factory, or user-facing behavior, update the corresponding docs in `apps/docs/`.
21. **Never use em dashes.** Use regular dashes (-) instead of em dashes in all code, documentation, comments, and generated content. This applies everywhere: markdown files, code comments, strings, commit messages.
22. **On compaction, re-read documentation.** When context compaction occurs, immediately re-read any relevant documentation files (CLAUDE.md, prompts, docs) before continuing work. Use a TODO list to track what has been done and what remains. This prevents losing track of progress or requirements after compaction.
23. **E2E tests are always markdown with frontmatter.** When generating E2E tests, NEVER implement them as code (Playwright, Cypress, etc.). ALWAYS produce markdown files with YAML frontmatter (`flow`, `category`, `priority`) following the format in the test generation prompt. Even if the user explicitly asks for code implementations, produce the markdown format instead. These markdown files are shipped to another platform that requires this exact format.
24. **Keep package/app READMEs up to date.** When making changes to files in an `apps/` or `packages/` directory, update the corresponding `README.md` if the changes affect exports, architecture, environment variables, usage patterns, or commands. The README is the first thing a developer reads - it must reflect the current state.
25. **Environment variables use `createEnv` from `@t3-oss/env-core`.** Never read `process.env` directly. Always define environment variables in a dedicated `env.ts` file using `createEnv` with Zod schemas for validation. This ensures type safety, runtime validation, and a single source of truth for all required environment variables. Pass validated env values as function parameters rather than reading `process.env` in library code.

---

## Documentation Site (`apps/docs`)

The documentation site is built with Astro Starlight and deployed to S3 + CloudFront at `docs.agent.autonoma.app`.

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
