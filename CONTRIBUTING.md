# Contributing to Autonoma AI

Thank you for your interest in contributing to Autonoma AI! We welcome contributions from the community and are grateful for any help you can provide.

Please read this guide carefully before submitting your contribution.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Commit Convention](#commit-convention)
- [Pull Requests](#pull-requests)
- [Issues](#issues)
- [Coding Standards](#coding-standards)
- [Project Structure](#project-structure)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to **conduct@autonoma.app**.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) 10.x (run `corepack enable` to use the version pinned in `package.json`)
- [Docker](https://www.docker.com/) (for PostgreSQL and Redis)

### Setup

1. Fork and clone the repository:

```bash
git clone https://github.com/<your-username>/autonoma.git
cd autonoma
```

2. Install dependencies:

```bash
pnpm install
```

3. Start infrastructure (PostgreSQL, Redis, and MinIO):

```bash
docker compose up -d
```

4. Configure environment variables:

```bash
cp .env.example .env
```

Fill in the required values. See `.env.example` for the full list grouped by service. For local development, `.env.example` includes MinIO-backed storage defaults for `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT`.

5. Set up the database:

```bash
pnpm db:generate
pnpm db:migrate
```

6. Start the development servers:

```bash
pnpm dev
```

This starts the API (port 4000) and UI (port 3000).

## Development Workflow

1. Create a new branch from `main`:

```bash
git checkout -b feat/my-feature
```

2. Make your changes and verify everything works:

```bash
pnpm typecheck    # Type checking
pnpm lint         # Linting
pnpm test         # Tests
pnpm build        # Full build
```

3. Commit your changes following the [commit convention](#commit-convention).

4. Push your branch and open a Pull Request.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) for all commits and PR titles. This enables automated changelog generation, semantic versioning, and a clean git history.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation changes only |
| `style` | Changes that do not affect the meaning of the code (formatting, white-space, etc.) |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `perf` | A code change that improves performance |
| `test` | Adding missing tests or correcting existing tests |
| `build` | Changes that affect the build system or external dependencies |
| `ci` | Changes to CI configuration files and scripts |
| `chore` | Other changes that don't modify src or test files |
| `revert` | Reverts a previous commit |

### Scope

The scope should be the name of the package or app affected (as perceived by the person reading the changelog):

- `api`, `ui`, `engine-web`, `engine-mobile`, `docs`
- `ai`, `db`, `types`, `engine`, `blacklight`, `storage`, `logger`
- `workflow`, `k8s`, `device-lock`, `try`, `analytics`

### Examples

```
feat(api): add webhook endpoint for GitHub App events
fix(engine-web): resolve timeout on network idle detection
docs: update README with setup instructions
refactor(ai): extract point detection into separate module
test(db): add integration tests for user repository
ci: add type checking step to PR workflow
chore: update dependencies
feat(ui)!: redesign test run dashboard
```

### Breaking Changes

Append `!` after the type/scope to indicate a breaking change, and include a `BREAKING CHANGE:` footer:

```
feat(api)!: change authentication flow to OAuth-only

BREAKING CHANGE: Basic auth endpoints have been removed.
All clients must use OAuth2 for authentication.
```

## Pull Requests

We actively welcome Pull Requests. Before submitting:

### Before You Start

- **Bug fixes** - Search existing [Issues](https://github.com/autonomaai/agent/issues) to make sure the bug has been reported. If not, open one first.
- **New features** - Open a [Discussion](https://github.com/autonomaai/agent/discussions) or Issue first to propose and discuss the feature. Unvetted features may be closed.
- **Good first issues** - If you're new to the project, look for issues labeled `good first issue`.

### Submitting a PR

1. Ensure no one else is already working on the same Issue. If an Issue exists, comment that you'd like to work on it.
2. Fork the repo, create your branch from `main`, and make your changes.
3. Your PR title **must** follow the [Conventional Commits](#commit-convention) format. This is enforced by CI.
4. Fill in the PR template with:
   - A clear summary of what changed and why
   - Steps to test your changes
   - Screenshots or recordings for UI changes
5. Make sure all checks pass before requesting a review:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### PR Review

- A maintainer will review your PR and may request changes.
- Please respond to review feedback promptly.
- Once approved, a maintainer will merge your PR.
- We prefer squash merges to keep the git history clean.

## Issues

### Reporting Bugs

When filing a bug report, include:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior vs actual behavior
- Environment details (OS, Node version, browser if applicable)
- Relevant logs or error messages
- Screenshots or recordings if applicable

### Requesting Features

Feature requests are welcome. Please provide:

- A clear description of the problem you're trying to solve
- Your proposed solution (if any)
- Any alternatives you've considered

## Coding Standards

This project enforces strict coding standards. Please review the full conventions in `CLAUDE.md`, but here are the key points:

### TypeScript

- **ESM-only** - no CommonJS. Every `package.json` has `"type": "module"`.
- **Strictest TypeScript** - all strict flags enabled, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **No `.js` extensions in imports** - use bare specifiers without file extensions.

### Error Handling

Use `fx` from `@autonoma/try` for all fallible operations:

```ts
import { fx } from "@autonoma/try";

const [result, error] = await fx.runAsync(() => fetchData());
if (error != null) return fx.failure(error);
return fx.success(result);
```

### Style

- **One export per file** - a file exports exactly one thing.
- **Prefer `undefined` over `null`** - use optional properties (`?`) instead of `| null`.
- **Always `??` instead of `||`** - and `!= null` / `== null` instead of truthy/falsy checks.
- **Early returns** - reduce nesting with guard clauses.
- **Extract complex conditions** into named variables.
- **No complex destructuring or spread** - build objects explicitly.

### Testing

- **Vitest** for all tests.
- **Prefer integration tests** over unit tests.
- Test files go in `test/` directories mirroring `src/`.

### Dependencies

Before adding a dependency, check `pnpm-workspace.yaml` for the catalog. If the dependency exists there, use `"catalog:"` as the version specifier.

## Project Structure

```
apps/
  api/              Hono + tRPC API server
  ui/               Vite + React 19 SPA
  engine-web/       Playwright web test execution
  engine-mobile/    Appium mobile test execution
  docs/             Documentation site
  jobs/             Background jobs

packages/
  ai/               AI primitives
  db/               Prisma schema + client
  types/            Shared Zod schemas and types
  engine/           Execution agent core
  blacklight/       UI component library
  try/              Error handling
  storage/          S3 file storage
  logger/           Sentry logging
  analytics/        PostHog analytics
  device-lock/      Redis device locking
  k8s/              Kubernetes helpers
  workflow/         Argo workflow builders
  utils/            Shared utilities
```

For detailed architecture documentation, see `CLAUDE.md` and the [docs site](https://docs.agent.autonoma.app).

---

Thank you for contributing!
