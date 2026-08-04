---
title: Package Guide
description: What each package and app does, what it exports, and when you would modify it.
---

## Packages

Every package in `packages/` is a shared library consumed by one or more apps. Each has exactly one concern.

Internal tooling is deliberately left out - the eval harnesses and their results database exist to measure and improve the agents, and have nothing to do with building or running the product.

:::caution[Mobile is dormant]
`emulator` and `engine-mobile` are still in the tree and still compile, but they are not part of what ships today - the only image that would link them, `workers/mobile`, is never built or deployed by any workflow, and neither package has had feature work since June 2026. The product is web-only. They are listed here because the code exists, not because it is a capability you can use.
:::

### agent-core

The agent loop itself - tool plumbing, the step cycle, retries, and context compaction. Platform-agnostic and model-agnostic; `engine` builds the execution agent on top of it.

**Key exports:** `Agent`, tool base classes, compaction helpers

**When to modify:** Changing how any agent in the codebase loops, calls tools, or compacts its context.

### ai

The **sharp-free** AI core: the model registry (LLM instances, providers, per-call cost collection), structured output generation, and text utilities. Everything screenshot-driven lives in `visual-ai` instead, so hosts that cannot load `sharp` - the API among them - can still call a model.

**Key exports:** `ModelRegistry`, `CostCollector`, `ObjectGenerator`, `AssertionSplitter`, `MODEL_ENTRIES`

**When to modify:** Adding a model or provider, changing pricing or cost attribution, or adjusting structured generation.

### analytics

PostHog server-side event tracking. Wraps `posthog-node` with Sentry trace linking. No-ops when not initialized, so it's safe to import in dev and test environments.

**Key exports:** `analytics` (singleton)

**When to modify:** Adding new server-side analytics events, changing event properties, or adjusting the PostHog integration.

### auth

Authentication - sessions, organisation membership, and the checks the API applies to every request.

**When to modify:** Changing how users sign in, or how access to an organisation or application is decided.

### billing

Subscription and billing logic. Handles plan management, usage tracking, and payment integration.

**Key exports:** Billing service classes and plan definitions

**When to modify:** Changing pricing plans, adding billing features, or integrating new payment providers.

### blacklight

Shared UI component library built on Radix UI + Tailwind CSS v4 + CVA. This is where all reusable frontend components live - buttons, cards, inputs, dialogs, tables, and more. Follows shadcn/ui patterns.

**Key exports:** `Button`, `Card`, `Input`, `Dialog`, `Table`, `Select`, `cn()`, and many more components

**When to modify:** Adding new UI components, updating component styles, or changing the design system. The path alias `@/*` maps to `packages/blacklight/src/*` inside the package.

### checkpoint

Run checkpoints: the record of what a run had established at each point, so a later run can compare against it.

**When to modify:** Changing what a checkpoint captures or how runs are compared over time.

### db

Prisma schema and generated client for PostgreSQL. This is the single source of truth for the database structure.

**Key exports:** `PrismaClient`, generated types for all models

**When to modify:** Adding or changing database tables, columns, relations, or indexes. After editing the schema, run `pnpm db:generate` and `pnpm db:migrate`.


### diffs

Test diff computation. Computes differences between test suite versions for change tracking and review.

**Key exports:** Diff computation functions

**When to modify:** Changing how test diffs are calculated or displayed.

### emulator

Mobile emulator management. Handles lifecycle management of iOS simulators and Android emulators.

**Key exports:** Emulator management classes

**When to modify:** Adding support for new device types, changing emulator configuration, or adjusting lifecycle management.

### engine

The core of test execution. This is a platform-agnostic AI agent that web and mobile engines extend. Contains the execution agent loop, command system (click, type, scroll, assert), driver interfaces, runner orchestration, and artifact management.

Everything is parameterized with generics (`TSpec` for command specs, `TContext` for driver context), so the same agent core works for both Playwright and Appium.

**Key exports:** `ExecutionAgent`, `ExecutionAgentRunner`, `AgentCommand`, `CommandRegistry`, driver interfaces (`ScreenDriver`, `MouseDriver`, `KeyboardDriver`, `NavigationDriver`, `ApplicationDriver`)

**When to modify:** Adding new commands to the agent, changing the execution loop, adjusting the system prompt, or modifying how steps are recorded.

### engine-mobile

Appium-based mobile test execution for iOS and Android. Implements the driver interfaces from `engine` using Appium/WebDriver. Uses `@autonoma/device-lock` for Redis-based device allocation. Linked into the `workers/mobile` image.

**When to modify:** Changing mobile-specific test execution behavior, adjusting Appium configuration, or adding support for new device types.

### engine-web

Playwright-based web test execution. Implements the driver interfaces from `engine` using Playwright's API. Handles browser lifecycle, screenshot capture, network idle detection, and video recording. Linked into the `workers/web`, `workers/diffs`, and `workers/investigation` images.

**When to modify:** Changing web-specific test execution behavior, adjusting Playwright configuration, or fixing browser-related issues.

### errors

Custom error hierarchy for the project. All errors extend `AutonomaError` with specific subclasses for different failure types.

**Key exports:** `AutonomaError`, `TestError`, `DriverError`, `PreconditionError`, `VerificationError`, `ThirdPartyError`

**When to modify:** Adding new error types or changing how errors are categorized.


### github

The GitHub App and API client - installation tokens, repository access, pull-request events, and the comments Autonoma posts back.

**When to modify:** Changing anything that talks to GitHub.

### image

Image processing utilities. Handles screenshot manipulation, resizing, and format conversion used throughout the execution pipeline.

**Key exports:** Image processing functions

**When to modify:** Changing how screenshots are processed, adding new image operations, or adjusting compression settings.

### integration-test

Test harness using Testcontainers. Provides `IntegrationHarness` and `integrationTestSuite` for writing integration tests that use real PostgreSQL and Redis containers.

**Key exports:** `IntegrationHarness`, `integrationTestSuite`

**When to modify:** Changing the test harness setup, adding new test utilities, or supporting new infrastructure in tests.

### investigation

The investigation agent: given a pull request, work out what changed and what it might have broken.

**When to modify:** Changing how investigations are selected, run, or reported.

### k8s

Kubernetes helpers. Utilities for interacting with the K8s API, managing pods, and reading cluster state.

**Key exports:** Kubernetes client wrappers and helpers

**When to modify:** Changing how the platform interacts with Kubernetes, or adding new K8s operations.

### logger

Sentry-based structured logging. Provides a logger that integrates with Sentry for error tracking, performance monitoring, and structured context.

**Key exports:** `logger` (root logger), `Logger` type

**When to modify:** Changing the logging format, adjusting Sentry integration, or adding new logging capabilities.

### scenario

Environment Factory scenario logic. Handles test scenario definitions, data seeding, and teardown for isolated test environments.

**Key exports:** Scenario classes and types

**When to modify:** Adding new test scenarios, changing how test data is seeded, or adjusting the Environment Factory protocol.

### secrets

Storage and retrieval of customer secrets - preview environment variables, signing secrets, and third-party tokens.

**When to modify:** Changing how secrets are stored, encrypted, or resolved at deploy time.

### storage

S3 file storage. Handles uploading and downloading artifacts (screenshots, videos, test results) to S3-compatible storage.

**Key exports:** Storage service classes

**When to modify:** Changing storage providers, adjusting upload/download logic, or adding new artifact types.

### test-updates

Test suite update logic. Handles applying changes to test suites - adding, removing, and modifying test cases.

**Key exports:** Test update service classes

**When to modify:** Changing how test suites are modified, or adding new update operations.

### try

Go-style error handling. Wraps a fallible call into a `[value, error]` tuple so the error path is explicit at the call site instead of hidden in a `try`/`catch`.

**Key exports:** `Try<T>`, `Success<T>`, `Failure`

**When to modify:** Rarely - it is a small, stable utility.

### types

Shared Zod schemas and TypeScript types. This is the contract layer between the API and frontend. Schemas defined here are used for tRPC input validation and frontend type inference.

**Key exports:** Zod schemas for all API inputs/outputs, TypeScript types, constants

**When to modify:** Adding new API endpoints, changing request/response shapes, or adding shared constants.

### utils

Shared utilities that don't fit into a more specific package.

**Key exports:** Various utility functions

**When to modify:** Adding general-purpose utilities used across multiple packages.

### visual-ai

The screenshot-driven half of the AI stack: visual condition checking, assertion checking, point detection (locating an element from a natural-language description), and object detection. Depends on `ai` and on `image`, which means `sharp`.

**Key exports:** `PointDetector`, `ObjectDetector`, `VisualConditionChecker`, `AssertChecker`

**When to modify:** Changing how elements are located on screen, or adjusting assertion logic.

### workflow

Temporal workflow definitions and client. Orchestrates test execution pipelines using Temporal workflows and activities.

**Key exports:** Workflow builder classes

**When to modify:** Changing how test execution is orchestrated, adjusting workflow templates, or adding new pipeline steps.

## Apps

### api

The backend server. Built with Hono (HTTP framework) and tRPC (type-safe API layer). Routers are thin - they wire tRPC procedures to controller files in `controllers/<routerName>/`. One file per procedure.

**When to modify:** Adding new API endpoints, changing business logic, or adjusting authentication.

### ui

The frontend SPA. Built with React 19, Vite, and TanStack Router. Compiled to static files - no SSR. Uses `@autonoma/blacklight` for all UI components.

**When to modify:** Adding new pages, changing the UI, or adjusting frontend behavior.

### previewkit

Preview environments. Builds each app in a pull request, provisions the databases and extra services it needs, deploys the whole stack to its own Kubernetes namespace, and tears it down when the PR closes.

**When to modify:** Changing how previews are built, deployed, configured, or destroyed.

### cli

Published to npm as `@autonoma-ai/planner`. Runs on the user's machine, reads their codebase, and generates the knowledge base, scenarios, test-data recipe, and E2E test suite. Bundled with tsup.

**When to modify:** Changing the planner pipeline, its terminal dashboard, or the coding-agent handoff for test data.

### workers

Temporal workers. Each subdirectory is its own deployable: `diffs`, `general`, `investigation`, `web`, `mobile`. They own the long-running pipeline - provisioning, seeding, running, reviewing - so a restart never loses a run in flight.

**When to modify:** Adding a workflow or activity, or changing how a run is orchestrated.

### cronjobs

Scheduled tasks that run on a timer rather than in response to an event.

**When to modify:** Adding or changing a scheduled task.

### docs

This documentation site. Built with Astro Starlight and deployed to S3 + CloudFront.

**When to modify:** Adding or updating documentation pages.

### jobs

Background job services, each deployed as a separate Docker image:

| Job | Purpose |
| --- | --- |
| **run-completion-notification** | Stripe billing refund on failed generations, plus the mark-failed reaper |

## Dependency graph

The general dependency flow (simplified):

```
apps (api, ui, workers, jobs)
 |
 +-- packages/types        (shared schemas - used by almost everything)
 +-- packages/db           (database - used by api, jobs)
 +-- packages/engine-web   (Playwright execution - used by workers/web, diffs, investigation)
 +-- packages/engine-mobile (Appium execution - used by workers/mobile)
 +-- packages/engine       (execution core - used by the engine packages)
 +-- packages/ai           (AI primitives - used by engine, jobs)
 +-- packages/try          (error handling - used by everything)
 +-- packages/logger       (logging - used by everything)
 +-- packages/errors       (error types - used by engine, api)
 +-- packages/storage      (S3 - used by api, engines, jobs)
 +-- packages/blacklight   (UI components - used by ui only)
 +-- packages/analytics    (PostHog - used by api)
 +-- packages/workflow     (Temporal workflows - used by api, workers)
```

Key relationships:

- `packages/engine` depends on `packages/ai` for all AI operations
- `packages/ai` is self-contained - it only depends on `try`, `logger`, and `image`
- `packages/types` is a leaf dependency - it depends on nothing else in the monorepo
- `packages/try` is a leaf dependency - used everywhere, depends on nothing
- Both `engine-web` and `engine-mobile` depend on `packages/engine` but never on each other
