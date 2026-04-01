---
title: Architecture Overview
description: High-level architecture of Autonoma AI - how the monorepo is organized, how data flows, and why each technology was chosen.
---

## How Autonoma works

Autonoma is an agentic E2E testing platform. Users describe tests in natural language, and an AI agent executes them on real browsers and devices. The core loop is:

1. User writes a test instruction ("Log in, go to settings, verify the avatar is visible")
2. The execution agent takes a screenshot of the current screen
3. An LLM decides which action to perform (click, type, scroll, assert)
4. Platform drivers execute the action (Playwright for web, Appium for mobile)
5. The agent records the step and repeats until the test is done

Everything else - the API, the UI, the jobs - exists to support this loop.

## Monorepo structure

The codebase is split into **apps** (deployable services) and **packages** (shared libraries). Each package has exactly one concern.

```
apps/
  api/              Hono + tRPC API server
  ui/               Vite + React 19 SPA
  engine-web/       Playwright web test execution
  engine-mobile/    Appium mobile test execution
  docs/             Astro Starlight documentation site
  jobs/             Background jobs (multiple sub-services)

packages/
  ai/               AI primitives - models, vision, point detection
  analytics/        PostHog server-side event tracking
  billing/          Subscription and billing logic
  blacklight/       Shared UI component library
  db/               Prisma schema + generated client
  diffs/            Test diff computation
  emulator/         Mobile emulator management
  engine/           Platform-agnostic execution agent core
  errors/           Custom error hierarchy
  image/            Image processing utilities
  integration-test/ Test harness with Testcontainers
  k8s/              Kubernetes helpers
  logger/           Sentry-based structured logging
  review/           Post-execution AI review
  scenario/         Environment Factory scenario logic
  storage/          S3 file storage
  test-updates/     Test suite update logic
  types/            Shared Zod schemas and TypeScript types
  utils/            Shared utilities
  workflow/         Argo workflow builders
```

### Why apps vs packages?

**Apps** are independently deployable. Each one becomes its own Docker image and runs as its own process. The API, UI, and each engine are separate images - they never share a runtime.

**Packages** are shared code. They're consumed by apps at build time via pnpm workspaces. A package like `@autonoma/ai` is used by both `engine-web` and `engine-mobile`, but it never runs on its own.

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
  |--- Redis ----> Device locks, caching
  |
  | (dispatches jobs)
  v
 Engine Web / Engine Mobile
  |
  | Execution Agent (packages/engine)
  |--- Playwright (web) or Appium (mobile)
  |--- AI models (packages/ai)
  v
 Test results, recordings, artifacts
```

**UI to API**: The React SPA communicates with the API exclusively through tRPC. Types flow end-to-end - the frontend never manually defines API response types. Zod schemas in `packages/types` are the single source of truth for both sides.

**API to Database**: The API uses Prisma as its ORM. The schema lives in `packages/db` and is shared across all backend services.

**API to Engines**: When a test run starts, the API dispatches it to the appropriate engine (web or mobile). Engines execute tests independently and report results back.

**Engines to AI**: During execution, engines call into `packages/ai` for element detection, visual assertions, and agent decision-making. AI calls go to external providers (Google Gemini, Groq, OpenRouter).

## Tech stack

| Layer | Technology | Why |
| --- | --- | --- |
| Runtime | Node.js 24, ESM-only | Latest LTS with native ESM. No CommonJS compatibility issues |
| Monorepo | pnpm workspaces + Turborepo | pnpm for fast, disk-efficient installs. Turborepo for cached, parallel builds |
| Language | TypeScript (strictest) | Full type safety with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and all strict flags |
| API | Hono + tRPC | Hono is fast and lightweight. tRPC gives end-to-end type safety without code generation |
| Frontend | React 19 + Vite + TanStack Router | Vite for fast dev builds. TanStack Router for type-safe routing with built-in data loading |
| Database | PostgreSQL + Prisma | PostgreSQL for reliability. Prisma for type-safe queries and migration management |
| Cache/Locking | Redis | Distributed device locking and caching across engine instances |
| AI | Gemini, Groq, OpenRouter via Vercel AI SDK | Multiple providers for different tasks. Vercel AI SDK unifies the interface |
| Web testing | Playwright | Most reliable browser automation library. Supports all major browsers |
| Mobile testing | Appium | Industry standard for iOS and Android automation on real devices |
| UI components | Radix UI + Tailwind CSS v4 + CVA | Accessible primitives (Radix), utility-first styling (Tailwind), type-safe variants (CVA) |
| Observability | Sentry | Error tracking, performance monitoring, and structured logging in one tool |
| Analytics | PostHog | Product analytics with server-side event tracking |
| Deployment | Kubernetes + Argo Workflows | K8s for orchestration. Argo for workflow-based test execution pipelines |

## The execution flow

This is the most important flow in the system - how a test goes from natural language to executed results.

### 1. Test creation

The user writes a test as a natural language instruction, optionally with a URL and configuration. The API stores it in PostgreSQL.

### 2. Test dispatch

When a test run starts, the API dispatches it to the appropriate engine based on the application type (web or mobile). For mobile, Redis-based device locking ensures exclusive access to physical devices.

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

Each engine (web, mobile) and each job type gets its own Docker image. This keeps images small and deployment independent. A change to the web engine doesn't require redeploying the mobile engine.

### Platform-agnostic agent core

All execution logic lives in `packages/engine`. Platform-specific apps (`engine-web`, `engine-mobile`) only implement driver interfaces (`ScreenDriver`, `MouseDriver`, etc.). The same agent loop, command system, and AI integration works for both Playwright and Appium.

## Deployment model

The platform runs on Kubernetes:

- **API** and **UI** are standard deployments with horizontal scaling
- **Engines** run on device-hosting machines (physical or virtual). Web engines need browsers, mobile engines need connected devices or emulators
- **Jobs** run as Argo Workflows - triggered on demand, scaled to zero when idle
- **Redis** handles distributed device locking across engine instances
- **PostgreSQL** is the single source of truth for all state
