# `@autonoma-ai/planner` (apps/cli)

The Autonoma test planner CLI - generates E2E test cases for any frontend codebase. Published to npm as `@autonoma-ai/planner` (bin: `autonoma-planner`), versioned independently from the rest of the monorepo via release-please (`cli-v*` tags).

## CRITICAL: Agent Architecture Principles

These are the most important rules in this codebase. Violating them causes cascading failures.

### 1. NO framework/language coupling in agent prompts or code

This tool analyzes ANY frontend codebase - React, Vue, Angular, Django, Rails, Svelte, or anything else. Agent prompts and supporting code MUST NEVER:

- Hardcode file extensions (`.tsx`, `.jsx`, `.vue`, `.svelte`)
- Hardcode directory patterns (`app/`, `pages/`, `_components/`, `src/app`)
- Hardcode framework patterns (`page.tsx`, `+page.svelte`, `layout.tsx`)
- Reference specific frameworks by name as instructions (e.g., "For Next.js, do X")
- Count files of a specific type as a proxy for complexity (e.g., counting `.tsx` files)
- Assume any routing convention, component naming convention, or directory structure

**Why:** The agents have tools (read_file, glob, grep, bash). They can discover the framework and patterns themselves. Hardcoding assumptions breaks on every project that doesn't match. The page finder agent already proves this works - it discovers pages without hardcoded patterns.

**Instead:** Tell agents WHAT to find (pages, models, components), not HOW to find them. Let them explore the codebase and discover the patterns. They are agents, not query engines.

### 2. NO project-specific content in prompts

Agent prompts MUST NEVER contain:
- Specific app names, route names, or feature names as examples
- Real code snippets from any specific project
- References to specific frameworks as "the default" or "most common"

**Why:** Project-specific examples bias the agent toward one pattern and cause hallucination on different projects.

**Instead:** Use abstract examples that work for any project. If you need examples, describe the CONCEPT, not a specific implementation.

### 3. Complexity comes from reading source, not counting files

Never use file counts, directory sizes, or glob results as a proxy for feature complexity. The agent reads the actual source code and judges complexity by what it finds - number of interactive elements, forms, workflows, conditional logic, etc.

**Why:** File organization varies wildly between projects. A monorepo might put 300 components in a shared `_components/` folder while the page files are empty wrappers. Counting files in the page directory would say "simple" when the feature is massive.

---

## TUI architecture (src/ui/)

The interactive dashboard is Ink 7 + React 19, and follows a strict store-first design:

- **`src/ui/store.ts` is the single source of truth.** The Ink tree is a pure projection of
  `RunState` via `useSyncExternalStore`. Never put run state in React state.
- **Pipeline code never imports Ink.** It talks to the UI through three seams only: the
  `src/ui/prompts.ts` facade (import it as `* as p`; blocking prompts render as the docked
  ACTION REQUIRED panel via the store's prompt bridge - there is no other prompt library),
  the active store (`getActiveStore()`, undefined when headless), and `core/ui-lifecycle.ts`
  (pause/resume, used by `core/interrupt.ts` suspend/resume for the coding-agent handoff).
- **Headless = no store.** The store singleton is only set while the TUI is mounted; every
  consumer must fall back to plain output when `getActiveStore()` returns undefined, keeping
  `--non-interactive`/CI output unchanged.
- **Rendering is a character grid** (`grid.ts` + `draw/`), not Ink flexbox - deterministic
  columns and borders. Repaints coalesce to one per 16ms burst plus a 250ms clock. **Never
  pass the Grid (or any large per-render object) as a React prop** - React retains prop
  objects per render, and a ~2MB grid retained at repaint rate leaks hundreds of MB per
  minute (this exact shape OOMed real runs; render it inline in the component that built it).
- Iterate visually with `pnpm ui:gallery` (fixture-driven scenes, Tab/Shift+Tab). Design
  rationale and constraints: `docs/ui-design-brief.md`; roadmap: `docs/tui-plan.md`.

## Tooling

This package follows the monorepo conventions (see the root `CLAUDE.md`): ESM-only, strictest TypeScript, pnpm + turborepo, `undefined` over `null`, `??`/`!= null`, no `.js` import extensions.

- **Package manager:** pnpm (shared root lockfile). Do NOT use bun for install/run.
- **Build:** `tsup` -> `dist/index.js` (the published bin). Run `pnpm --filter @autonoma-ai/planner build`.
- **Dev:** `pnpm --filter @autonoma-ai/planner dev` (`tsx src/index.ts`).
- **Typecheck:** `tsc --noEmit`. **Lint:** `oxlint`. **Test:** `vitest run`.
- Shared dependency versions (`ai`, `zod`, `typescript`, `tsx`, `vitest`, `@types/node`) come from the workspace `catalog:` in `pnpm-workspace.yaml`. CLI-only deps (`@clack/*`, `@openrouter/ai-sdk-provider`, `glob`, etc.) are pinned locally.

## Release

Independent of the monorepo's k8s release, and driven by its own release-please workflow.

- **`.github/workflows/cli-release-please.yml`** runs release-please in manifest mode against the cli-only files `release-please-config-cli.json` + `.release-please-manifest-cli.json`, tracking this package as the `cli` component (`cli-v*` tags). It is deliberately separate from the root release flow: the root `release-please.yml` runs in single-package mode (top-level `release-type: node`), which ignores any extra packages in the shared `release-please-config.json`. Do not add `apps/cli` back to the shared config/manifest - it would be inert there and is a footgun if the root workflow is ever converted to manifest mode.
- On a published `cli-v*` GitHub release, **`.github/workflows/cli-publish.yml`** publishes to npm (`@latest`). The k8s production deploy (`production-build.yml`) only fires on root `v*` tags and explicitly skips `cli-v*`.
- **Canary channel:** `.github/workflows/cli-canary.yml` publishes `<next-patch>-canary.<sha>` to the `canary` dist-tag; it derives the base version from `.release-please-manifest-cli.json`.
- **npm auth:** the `CLI_NPM_TOKEN` secret must be an npm token with **2FA bypass** enabled (an Automation classic token, or a granular token with the "Bypass two-factor authentication" box checked) and read/write on `@autonoma-ai/planner`. A classic publish token without 2FA bypass fails in CI with `ERR_PNPM_OTP_NON_INTERACTIVE` because npm demands an interactive OTP.
