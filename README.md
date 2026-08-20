<div align="center">

<br/>
<br/>

<picture>
 <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.png">
 <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo-light.png">
 <img alt="Autonoma" src=".github/assets/logo-light.png">
</picture>

<br/>
<br/>

**End-to-end tests that write themselves, run themselves, and review your pull requests.**

Connect a repository. Every PR gets a live preview environment, an AI agent that exercises your app in a real browser, and a review comment that says what broke - with a video, a screenshot, and the line of code that caused it.

[![License](https://img.shields.io/badge/license-BUSL--1.1-C2E812)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/Autonoma-AI/autonoma?style=flat)](https://github.com/Autonoma-AI/autonoma/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Autonoma-AI/autonoma)](https://github.com/Autonoma-AI/autonoma/graphs/contributors)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/nsYQExXTsQ)

[Website](https://getautonoma.com) · [Docs](https://docs.autonoma.app) · [Discord](https://discord.gg/nsYQExXTsQ) · [Local setup](#running-it-locally) · [Contributing](CONTRIBUTING.md)

</div>

## What is Autonoma?

Autonoma is an agentic end-to-end testing platform for web applications. You don't write test scripts and you don't maintain selectors. Autonoma reads your codebase, generates a suite of natural-language tests, and runs them against a fresh preview deployment of every pull request. An AI agent drives a real browser: it looks at the screen, decides what to click, asserts what it sees, and heals itself when your UI moves.

When something breaks, you get more than a red check. Autonoma reviews the run and opens an issue on the PR: what you expected, what actually happened, the screenshot and video of the moment it failed, and the code it suspects.

<p align="center">
  <img src=".github/assets/pr-review.webp" alt="A pull request review: one open bug, a written report, and the checkpoint history for the branch" width="100%">
</p>

<p align="center">
  <img src=".github/assets/analysis-issue.webp" alt="A reported issue: the screenshot of the failing run, what was expected, what actually happened, and why it matters" width="100%">
</p>

## How it works

Every pull request runs the same loop:

1. **Pull request** - you open a PR, or push a commit to one.
2. **Preview environment** - Autonoma builds an isolated, full-stack preview of your app for that PR and gives it a live URL.
3. **Seed data** - the Environment Factory creates fresh, isolated test data, so every run starts from a known state.
4. **Run tests** - the agent exercises the app in a real browser, one natural-language test at a time.
5. **Review** - Autonoma reviews each run, separates real bugs from flaky infrastructure, and comments the result on the PR.

When the PR closes, the preview environment and its data are torn down automatically.

## What you set up

Three pieces, in order. The first one alone gets you live.

| Piece | What it does | |
|---|---|---|
| **1. Preview environments** | Install the GitHub app and describe your stack - apps, databases, variables. Every PR then gets a live, isolated preview and an automated review. | [Docs](https://docs.autonoma.app/preview-environments/) |
| **2. The Planner CLI** | One command reads your codebase and generates a complete E2E suite: your pages, flows, scenarios, and the test-data helpers to run them. | [Docs](https://docs.autonoma.app/test-planner/) |
| **3. The Environment Factory** | One endpoint in your backend that creates isolated test data before each run and tears it down after. SDKs for TypeScript, Python, Go, Ruby, Rust, Java, Elixir, and PHP. | [Docs](https://docs.autonoma.app/environment-factory/) |

```bash
# Generate a test suite for the repo you are standing in
AUTONOMA_API_TOKEN=<api-token> AUTONOMA_GENERATION_ID=<generation-id> npx @autonoma-ai/planner@latest
```

Tests are plain Markdown with YAML frontmatter. The agent works out how to run them:

```markdown
---
title: "Checkout completes with a saved card"
description: "Verify a returning customer can place an order with a saved card"
intent: "Placing an order with a saved card creates the order and shows its number"
criticality: critical
scenario: standard
flow: "Checkout"
verification: "Open Order history, assert the new order number is listed"
---

Open the cart, go to checkout, pick the saved Visa ending in 4242,
place the order, and confirm the order number appears.
```

## Running it locally

### Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) 10.x (`corepack enable` uses the version pinned in `package.json`)
- [Docker](https://www.docker.com/), for PostgreSQL and Redis

### Setup

```bash
git clone https://github.com/Autonoma-AI/autonoma.git
cd autonoma
pnpm install
docker compose up -d          # PostgreSQL :5432, Redis :6379, Temporal :7233 (UI :8233)
cp .env.example .env
pnpm db:generate && pnpm db:migrate
pnpm dev                      # API on :4000, UI on :3000
```

At minimum, `.env` needs:

| Variable | Description |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/autonoma` |
| `REDIS_URL` | `redis://localhost:6379` |
| `BETTER_AUTH_SECRET` | Any random string, for session signing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials |
| `GEMINI_API_KEY` | Google Gemini API key, for the AI features |

See `.env.example` for the full list, grouped by service, and the [development setup guide](https://docs.autonoma.app/development/setup/) for the long version.

### Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start API + UI in development mode |
| `pnpm build` | Build all packages and apps |
| `pnpm typecheck` | Type-check every package |
| `pnpm lint` | Lint every package |
| `pnpm test` | Run the test suites |
| `pnpm check` | Lint and format with Biome |
| `pnpm db:generate` | Generate the Prisma client from the schema |
| `pnpm db:migrate` | Run database migrations |
| `pnpm docs` | Start the documentation site on :4321 |

## Repository layout

A pnpm + Turborepo monorepo, ESM-only, TypeScript on its strictest settings.

```
apps/
  api/           Hono + tRPC API server
  ui/            React 19 + Vite SPA
  cli/           @autonoma-ai/planner - the test-planner CLI
  previewkit/    Per-PR preview environment builder and deployer
  engine-web/    Playwright-based web test execution
  engine-mobile/ Appium-based mobile test execution
  workers/       Temporal workers (web, diffs, general)
  docs/          Astro Starlight documentation site

packages/
  engine/        Platform-agnostic execution agent and command system
  agent-core/    Agent loop primitives
  ai/            Model registry and structured generation (sharp-free)
  visual-ai/     Screenshot-driven checkers, point and object detection
  diffs/         PR diff analysis
  scenario/      Environment Factory protocol and test-data scenarios
  checkpoint/    Per-commit run state
  db/            Prisma schema and generated client
  types/         Shared Zod schemas and TypeScript types
  blacklight/    Shared UI component library
  workflow/      Temporal workflow definitions
```

Most packages carry their own README. [`packages/engine`](packages/engine/README.md) and [`packages/ai`](packages/ai/README.md) go deepest on the agent and the AI primitives, and the [architecture overview](https://docs.autonoma.app/development/architecture/) explains how the pieces fit together.

## Execution flow

```
Natural-language test
        |
   Execution agent (packages/engine)
        |
   Screenshot -> model decides an action -> execute -> record the step
        |                                        |
   Point detection (packages/visual-ai)    Platform drivers
        |                                   |          |
   Gemini / Moondream                  Playwright    Appium
                                         (web)      (mobile)
```

## Tech stack

**Runtime** Node.js 24, ESM-only · **Monorepo** pnpm workspaces + Turborepo · **Language** TypeScript, strictest config · **API** Hono + tRPC · **Frontend** React 19, Vite, TanStack Router, Tailwind CSS v4 · **Database** PostgreSQL + Prisma · **Cache and locking** Redis · **AI** Gemini, Groq, OpenRouter via the Vercel AI SDK · **Browser** Playwright · **Mobile** Appium · **Orchestration** Temporal on Kubernetes · **Observability** Sentry + PostHog

## Contributing

Bug reports, feature requests, and pull requests are all welcome - start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md).

Come say hello on [Discord](https://discord.gg/nsYQExXTsQ).

## License

[Business Source License 1.1](LICENSE.md). Read it, modify it, self-host it, and run it in production - the one thing you may not do is sell it as a competing commercial service. It converts to Apache 2.0 on March 23, 2028. See [LICENSE.md](LICENSE.md) for the exact terms.
