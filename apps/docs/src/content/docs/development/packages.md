---
title: Package Guide
description: What each package and app does, what it exports, and when you would modify it.
---

## Packages

Every package in `packages/` is a shared library consumed by one or more apps. Each has exactly one concern.

### ai

AI primitives used by the execution agent. Contains the model registry (manages LLM instances and providers), visual AI (screenshot analysis, assertion checking, element selection), point detection (locating UI elements from natural language descriptions), object detection (bounding box generation), and structured output generation.

**Key exports:** `ModelRegistry`, `PointDetector`, `ObjectDetector`, `VisualConditionChecker`, `AssertChecker`, `ObjectGenerator`, `AssertionSplitter`

**When to modify:** Adding a new AI model or provider, changing how elements are detected, adjusting assertion logic, or adding a new visual AI capability.

### analytics

PostHog server-side event tracking. Wraps `posthog-node` with Sentry trace linking. No-ops when not initialized, so it's safe to import in dev and test environments.

**Key exports:** `analytics` (singleton)

**When to modify:** Adding new server-side analytics events, changing event properties, or adjusting the PostHog integration.

### billing

Subscription and billing logic. Handles plan management, usage tracking, and payment integration.

**Key exports:** Billing service classes and plan definitions

**When to modify:** Changing pricing plans, adding billing features, or integrating new payment providers.

### blacklight

Shared UI component library built on Radix UI + Tailwind CSS v4 + CVA. This is where all reusable frontend components live - buttons, cards, inputs, dialogs, tables, and more. Follows shadcn/ui patterns.

**Key exports:** `Button`, `Card`, `Input`, `Dialog`, `Table`, `Select`, `cn()`, and many more components

**When to modify:** Adding new UI components, updating component styles, or changing the design system. The path alias `@/*` maps to `packages/blacklight/src/*` inside the package.

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

### errors

Custom error hierarchy for the project. All errors extend `AutonomaError` with specific subclasses for different failure types.

**Key exports:** `AutonomaError`, `TestError`, `DriverError`, `PreconditionError`, `VerificationError`, `ThirdPartyError`

**When to modify:** Adding new error types or changing how errors are categorized.

### image

Image processing utilities. Handles screenshot manipulation, resizing, and format conversion used throughout the execution pipeline.

**Key exports:** Image processing functions

**When to modify:** Changing how screenshots are processed, adding new image operations, or adjusting compression settings.

### integration-test

Test harness using Testcontainers. Provides `IntegrationHarness` and `integrationTestSuite` for writing integration tests that use real PostgreSQL and Redis containers.

**Key exports:** `IntegrationHarness`, `integrationTestSuite`

**When to modify:** Changing the test harness setup, adding new test utilities, or supporting new infrastructure in tests.

### k8s

Kubernetes helpers. Utilities for interacting with the K8s API, managing pods, and reading cluster state.

**Key exports:** Kubernetes client wrappers and helpers

**When to modify:** Changing how the platform interacts with Kubernetes, or adding new K8s operations.

### logger

Sentry-based structured logging. Provides a logger that integrates with Sentry for error tracking, performance monitoring, and structured context.

**Key exports:** `logger` (root logger), `Logger` type

**When to modify:** Changing the logging format, adjusting Sentry integration, or adding new logging capabilities.

### review

Post-execution AI review. Analyzes test execution recordings and results to validate whether tests passed correctly.

**Key exports:** Review service classes

**When to modify:** Changing how test results are reviewed, adjusting AI review prompts, or adding new review criteria.

### scenario

Environment Factory scenario logic. Handles test scenario definitions, data seeding, and teardown for isolated test environments.

**Key exports:** Scenario classes and types

**When to modify:** Adding new test scenarios, changing how test data is seeded, or adjusting the Environment Factory protocol.

### storage

S3 file storage. Handles uploading and downloading artifacts (screenshots, videos, test results) to S3-compatible storage.

**Key exports:** Storage service classes

**When to modify:** Changing storage providers, adjusting upload/download logic, or adding new artifact types.

### test-updates

Test suite update logic. Handles applying changes to test suites - adding, removing, and modifying test cases.

**Key exports:** Test update service classes

**When to modify:** Changing how test suites are modified, or adding new update operations.

### types

Shared Zod schemas and TypeScript types. This is the contract layer between the API and frontend. Schemas defined here are used for tRPC input validation and frontend type inference.

**Key exports:** Zod schemas for all API inputs/outputs, TypeScript types, constants

**When to modify:** Adding new API endpoints, changing request/response shapes, or adding shared constants.

### utils

Shared utilities that don't fit into a more specific package.

**Key exports:** Various utility functions

**When to modify:** Adding general-purpose utilities used across multiple packages.

### workflow

Argo workflow builders. Constructs Argo Workflow manifests for orchestrating test execution pipelines on Kubernetes.

**Key exports:** Workflow builder classes

**When to modify:** Changing how test execution is orchestrated, adjusting workflow templates, or adding new pipeline steps.

## Apps

### api

The backend server. Built with Hono (HTTP framework) and tRPC (type-safe API layer). Routers are thin - they wire tRPC procedures to controller files in `controllers/<routerName>/`. One file per procedure.

**When to modify:** Adding new API endpoints, changing business logic, or adjusting authentication.

### ui

The frontend SPA. Built with React 19, Vite, and TanStack Router. Compiled to static files - no SSR. Uses `@autonoma/blacklight` for all UI components.

**When to modify:** Adding new pages, changing the UI, or adjusting frontend behavior.

### engine-web

Playwright-based web test execution. Implements the driver interfaces from `packages/engine` using Playwright's API. Handles browser lifecycle, screenshot capture, network idle detection, and video recording.

**When to modify:** Changing web-specific test execution behavior, adjusting Playwright configuration, or fixing browser-related issues.

### engine-mobile

Appium-based mobile test execution for iOS and Android. Implements the same driver interfaces using Appium/WebDriver. Uses `@autonoma/device-lock` for Redis-based device allocation.

**When to modify:** Changing mobile-specific test execution behavior, adjusting Appium configuration, or adding support for new device types.

### docs

This documentation site. Built with Astro Starlight and deployed to S3 + CloudFront.

**When to modify:** Adding or updating documentation pages.

### jobs

Background job services, each deployed as a separate Docker image:

| Job | Purpose |
| --- | --- |
| **generation-reviewer** | AI review of generated test cases |
| **replay-reviewer** | Post-test AI validation using video recordings |
| **run-completion-notification** | Slack/email notifications when test runs complete |
| **test-case-generator** | AI-powered test case generation from app descriptions |
| **generation-assigner** | Assigns generated tests to appropriate scenarios |
| **scenario** | Environment Factory scenario execution |
| **diffs** | Computes test suite diffs |

## Dependency graph

The general dependency flow (simplified):

```
apps (api, ui, engines, jobs)
 |
 +-- packages/types        (shared schemas - used by almost everything)
 +-- packages/db           (database - used by api, jobs)
 +-- packages/engine       (execution core - used by engines)
 +-- packages/ai           (AI primitives - used by engine, jobs)
 +-- packages/try          (error handling - used by everything)
 +-- packages/logger       (logging - used by everything)
 +-- packages/errors       (error types - used by engine, api)
 +-- packages/storage      (S3 - used by api, engines, jobs)
 +-- packages/blacklight   (UI components - used by ui only)
 +-- packages/analytics    (PostHog - used by api)
 +-- packages/k8s          (K8s helpers - used by api, workflow)
 +-- packages/workflow     (Argo workflows - used by api)
```

Key relationships:

- `packages/engine` depends on `packages/ai` for all AI operations
- `packages/ai` is self-contained - it only depends on `try`, `logger`, and `image`
- `packages/types` is a leaf dependency - it depends on nothing else in the monorepo
- `packages/try` is a leaf dependency - used everywhere, depends on nothing
- Both `engine-web` and `engine-mobile` depend on `packages/engine` but never on each other
