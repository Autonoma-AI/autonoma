---
title: Architecture Overview
description: High-level architecture of Autonoma AI - how the monorepo is organized, how data flows, and why each technology was chosen.
---

## How Autonoma works

Autonoma is an agentic E2E testing platform. Tests are written in natural language - usually generated from the codebase by the planner rather than written by hand - and an AI agent executes them in a real browser. The core loop is:

1. A test says what to verify ("Log in, go to settings, check the avatar is visible")
2. The execution agent takes a screenshot of the current screen
3. An LLM decides which action to perform (click, type, scroll, assert)
4. A platform driver executes it - Playwright, against the pull request's preview environment
5. The agent records the step and repeats until the test is done

Around that loop sits the rest of the product: previewkit builds the environment each run needs, the Environment Factory seeds its data, and the API and workers orchestrate the whole thing and report back on the pull request.

## Monorepo structure

The codebase is split into **apps** (deployable services) and **packages** (shared libraries). Each package has exactly one concern.

```
apps/
  api/              Hono + tRPC API server
  ui/               Vite + React 19 SPA
  previewkit/       Preview environments - builds and deploys a PR's stack to Kubernetes
  cli/              @autonoma-ai/planner - the published test-planner CLI
  workers/          Temporal workers: diffs, general, web, mobile
  jobs/             Standalone background jobs
  cronjobs/         Scheduled tasks
  docs/             Astro Starlight documentation site

packages/
  agent-core/       The agent loop, tool plumbing, and compaction
  agent-guidance/   Guidance Autonoma gives an agent or human when a request cannot proceed
  ai/               Sharp-free AI core - model registry, structured generation
  visual-ai/        Screenshot-driven AI - visual checkers, point detection
  analytics/        PostHog server-side event tracking
  auth/             Authentication
  billing/          Credits, top-ups, and Stripe
  blacklight/       Shared UI component library
  checkpoint/       Run checkpoints
  db/               Prisma schema + generated client
  diffs/            Change analysis for a pull request
  emulator/         Mobile emulator management (dormant)
  engine/           Platform-agnostic execution agent core
  engine-web/       Playwright web test execution
  engine-mobile/    Appium mobile test execution (dormant - see below)
  errors/           Custom error hierarchy
  github/           GitHub App and API client
  image/            Image processing utilities
  integration-test/ Test harness with Testcontainers
  k8s/              Kubernetes helpers
  logger/           Sentry-based structured logging
  scenario/         Environment Factory scenario logic
  secrets/          Secret storage and retrieval
  storage/          S3 file storage
  test-suite/       A branch's suite lineage - snapshots, the open snapshot, and runs
  test-updates/     Test suite update logic (deprecated - migrating to test-suite)
  try/              Go-style [value, error] result tuples
  types/            Shared Zod schemas and TypeScript types
  utils/            Shared utilities
  workflow/         Temporal workflow definitions
```

:::caution[Mobile is dormant]
`engine-mobile` and `emulator` are still in the tree and still compile, but they are **not part of what ships today**. Neither has a Dockerfile, and neither has had feature work since June 2026 - changes since have been repo-wide sweeps. The product is web-only: read anything below about Appium, devices, or emulators as describing code that exists, not a capability you can use.
:::

### Why apps vs packages?

**Apps** are independently deployable. Each one becomes its own image and runs as its own process - the API, the UI, previewkit, and each worker never share a runtime. `apps/cli` is the exception: it is published to npm as `@autonoma-ai/planner` and runs on the user's machine.

**Packages** are shared code, consumed at build time via pnpm workspaces; none of them runs on its own. A package like `@autonoma/engine` is used by every engine, and `@autonoma/ai` by anything that calls a model.

## How the apps connect

```
Browser
  |
  | HTTP (port 3000)
  v
 UI (Vite + React SPA)
  |
  | tRPC (port 4000)
  v
 API (Hono + tRPC)
  |
  |--- Prisma ---> PostgreSQL
  |--- Redis ----> Caching
  |
  | (starts a Temporal workflow)
  v
 Workers (apps/workers)
  |
  |--- previewkit ---> builds and deploys the PR's stack
  |--- Environment Factory ---> seeds test data for the run
  v
 Engine Web
  |
  | Execution Agent (packages/engine)
  |--- Playwright
  |--- AI models (packages/ai, packages/visual-ai)
  v
 Results, recordings, artifacts -> reviewed -> comment on the PR
```

**UI to API**: The React SPA communicates with the API exclusively through tRPC. Types flow end-to-end - the frontend never manually defines API response types. Zod schemas in `packages/types` are the single source of truth for both sides.

**API to Database**: The API uses Prisma as its ORM. The schema lives in `packages/db` and is shared across all backend services.

**API to workers**: A pull-request event starts a Temporal workflow rather than calling an engine directly. The workers in `apps/workers` own the long-running pipeline - provisioning the preview, seeding data, running the suite, reviewing the result - so a restart never loses a run in flight.

**Engines to AI**: During execution, engines call `packages/ai` for structured generation and `packages/visual-ai` for element detection and visual assertions. The two are split because `visual-ai` depends on `sharp`, which some hosts (the API among them) cannot load. Calls go to external providers - Google Gemini, Groq, OpenRouter.

## Tech stack

| Layer | Technology | Why |
| --- | --- | --- |
| Runtime | Node.js 24, ESM-only | Latest LTS with native ESM. No CommonJS compatibility issues |
| Monorepo | pnpm workspaces + Turborepo | pnpm for fast, disk-efficient installs. Turborepo for cached, parallel builds |
| Language | TypeScript (strictest) | Full type safety with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and all strict flags |
| API | Hono + tRPC | Hono is fast and lightweight. tRPC gives end-to-end type safety without code generation |
| Frontend | React 19 + Vite + TanStack Router | Vite for fast dev builds. TanStack Router for type-safe routing with built-in data loading |
| Database | PostgreSQL + Prisma | PostgreSQL for reliability. Prisma for type-safe queries and migration management |
| Cache/Locking | Redis | Caching, and distributed locking where instances share a resource |
| AI | Gemini, Groq, OpenRouter via Vercel AI SDK | Multiple providers for different tasks. Vercel AI SDK unifies the interface |
| Web testing | Playwright | Most reliable browser automation library. Supports all major browsers |
| Mobile testing | Appium | Present in `engine-mobile`, currently dormant - the shipped product is web-only |
| UI components | Radix UI + Tailwind CSS v4 + CVA | Accessible primitives (Radix), utility-first styling (Tailwind), type-safe variants (CVA) |
| Observability | Sentry | Error tracking, performance monitoring, and structured logging in one tool |
| Analytics | PostHog | Product analytics with server-side event tracking |
| Deployment | Kubernetes + Temporal | K8s for orchestration. Temporal for workflow-based test execution pipelines |

## The execution flow

This is the most important flow in the system - how a test goes from natural language to executed results.

### 1. Test creation

Tests are natural-language markdown. Most are generated by the planner (`apps/cli`) reading the customer's codebase and uploaded to Autonoma; they can also be edited by hand. The API stores them in PostgreSQL.

### 2. Test dispatch

A pull-request event starts a Temporal workflow. It provisions the preview environment for that PR, asks the Environment Factory to seed the data the scenario needs, and then hands the suite to the web engine.

### 3. Execution agent loop

The execution agent (`packages/engine`) runs a loop powered by the Vercel AI SDK:

```
Screenshot -> LLM decides action -> Execute command -> Record step -> Repeat
```

The agent has access to these commands:

| Command | What it does |
| --- | --- |
| **click** | Uses vision AI to locate an element from a natural language description, then clicks it |
| **type** | Locates an element, clicks it, then types text |
| **scroll** | Scrolls up or down |
| **assert** | Checks visual conditions against the current screenshot |
| **wait** | Pauses for a specified duration (for loading states) |

The LLM (currently Gemini) sees the screenshot, the test instruction, and the steps taken so far, then decides which command to call next. When it determines the test is complete (or has failed), it calls `execution-finished`.

### 4. AI-powered element detection

Instead of CSS selectors or XPaths, the agent uses vision models to find UI elements. The `PointDetector` takes a screenshot and a natural language description ("the blue Submit button") and returns pixel coordinates. This is what makes tests resilient to UI changes - the AI adapts to visual changes automatically.

### 5. Results and artifacts

Every test run produces:

- Step-by-step execution log with before/after screenshots
- Video recording of the entire session
- AI conversation log (what the model "thought" at each step)
- Success/failure status with reasoning

These artifacts are stored in S3 and accessible through the UI.

## Key design decisions

### ESM-only

Every `package.json` has `"type": "module"`. No CommonJS anywhere. This eliminates an entire class of import/export bugs and aligns with the direction of the Node.js ecosystem.

### Strictest TypeScript

All strict flags enabled, including `noUncheckedIndexedAccess` (array/object access returns `T | undefined`) and `exactOptionalPropertyTypes`. This catches real bugs at compile time. It's more work upfront, but prevents entire categories of runtime errors.

### Constructor injection

All dependencies are passed through constructors. No DI framework, no decorators, no magic. You can read any class and immediately see what it depends on.

### Separate Docker images

Each worker (web, mobile) and each job type gets its own Docker image, linking in the engine package it needs. This keeps images small and deployment independent. A change to the web engine doesn't require redeploying the mobile worker.

### Platform-agnostic agent core

All execution logic lives in `packages/engine`. Platform-specific apps (`engine-web`, `engine-mobile`) only implement driver interfaces (`ScreenDriver`, `MouseDriver`, etc.). The same agent loop, command system, and AI integration works for both Playwright and Appium.

## Deployment model

The platform runs on Kubernetes:

- **API** and **UI** are standard deployments with horizontal scaling
- **Engines** run on device-hosting machines (physical or virtual). Web engines need browsers, mobile engines need connected devices or emulators
- **Jobs** run as Temporal workflows - triggered on demand via Temporal workers
- **Redis** handles distributed device locking across engine instances
- **PostgreSQL** is the single source of truth for all state
