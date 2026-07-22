# Autonoma Planner CLI — TUI Design Brief

A brief for redesigning the terminal UI (TUI) of the Autonoma test‑planner CLI. It
captures the **purpose** of the interface, the **product context** a designer needs,
**every decision** we've made, and **all the feedback** gathered from real runs —
both what's been addressed and what's still open. Hand this to design; it should be
enough to produce a proper spec without re-deriving the context.

---

## 1. What this tool is

`@autonoma-ai/planner` is a CLI that **generates an end‑to‑end (E2E) test suite from
any frontend codebase**. It runs a pipeline of AI agents that read the repo, learn the
app, model its data, design realistic test scenarios, wire up test‑data factories, and
finally write the tests. It works on any stack (React, Vue, Angular, Django, Rails,
Svelte, …) — there are **no framework assumptions** anywhere.

It's a long‑running, partly‑interactive process: a full run can take **~2 hours**, and
at several points it pauses to ask the user to review/approve output or to wire up test
data against their locally‑running app.

It is also a **funnel surface** for Autonoma — the felt quality of this experience
matters for conversion, not just utility.

### The old UI and why we're replacing it
The previous UI used `@clack/prompts` + scattered `console.log`. The fatal problem:
**the generated content was invisible.** During long runs the user had no idea what was
happening or what was being produced. The new UI's entire reason to exist is
**visibility**.

---

## 2. The north star

> **At every moment the user should effortlessly know: what's happening now, what's
> been produced, how far along we are / how long is left, and whether anything is being
> asked of them — and they should be able to read the generated work.**

The **hero of the UI is the generated content itself** — the actual files being written
(`AUTONOMA.md`, `scenarios.md`, `entity-audit.md`, `recipe.json`, the test `.md` files),
shown live, front and center, as the agent produces them. This is the single most
important improvement over the old UI. Everything else (pipeline, progress, prompts)
supports it.

### Design principles (from the user's feedback)
1. **Self‑explanatory.** Every screen should explain *what it is* and *why it exists*.
   The user saw a "Map your data models — Continue?" prompt and didn't understand why
   the step exists or what the interface was. Copy must teach, not assume.
2. **Obvious progress.** It must be unmistakable that work is happening — show the
   agent's function/tool calls streaming live, prominently (not a tiny footnote).
3. **Clear asks.** When the tool needs the user to do something, it must be impossible
   to miss, and obvious what to do.
4. **Readable output.** The user must be able to scroll and read long generated
   documents comfortably; scrolling must never scroll the terminal itself.
5. **Clear focus & controls.** It must always be obvious which area is active and which
   keys do what — context‑sensitive, color‑coded controls (like a good IDE / TUI).
6. **Calm, not noisy.** No flicker; text must stay selectable; don't repaint the world.

---

## 3. The pipeline (what the UI must visualize)

Six sequential steps. Names should be **plain‑language and explain the "why"** — the
internal names are in parentheses for engineering reference only.

| # | Step (UI label) | What it does (plain language) | Produces | Sub‑progress | Time budget |
|---|---|---|---|---|---|
| 1 | **Map pages** (`pagesFinder`) | Find every page/route in the app — the surface area to cover | `pages.json` | N routes found | ~5 min |
| 2 | **Build knowledge base** (`kb`) | Read those pages to learn the app's features, flows, and UI | `AUTONOMA.md` | pages read / total | ~5 min |
| 3 | **Model data** (`entityAudit`) | Find what the app stores (users, orgs, orders…) and how each gets created, so we can generate realistic test data | `entity-audit.md` | **13/35 models** | ~5 min |
| 4 | **Design scenarios** (`scenarioRecipe`) | Decide the concrete, realistic data each test will run against | `scenarios.md` | — | ~5 min |
| 5 | **Set up test data** (`recipeBuilder`) | Wire up small factories (via the Autonoma SDK) that create & tear down test data in *your* database; tested live against your running app | `recipe.json` | N / M entities | **1–2 h** (user‑paced) |
| 6 | **Write E2E tests** (`testGenerator`) | Write the actual tests, page by page, depth proportional to complexity | `qa-tests/**/*.md` | N tests written | ~20–30 min |

Notes:
- **Step 3 is a concrete example of the "explain why" problem.** "Model data / Map your
  data models" meant nothing to the user. The UI should say something like: *"Finding
  what your app stores and how it's created, so the tests can create realistic data."*
- **Step 5 is the longest and most interactive** (per‑entity review, live validation
  against the user's local server). It dominates the ETA and is the riskiest screen.
- ETA budgets above are the agreed defaults; total ≈ 1h50m–2h15m.

### Artifacts and their one‑liners
The middle column lists files as they're produced, each with a friendly description and
a status (`PENDING` → `RECEIVING` → `DONE`):
- `pages.json` — "Every route in the app"
- `AUTONOMA.md` — "What your app does"
- `entity-audit.md` — "What your app stores"
- `scenarios.md` — "The data your tests run against"
- `recipe.json` — "How test data is created"
- `qa-tests/**/*.md` — individual tests ("tests/ · natural language")

---

## 4. Current layout (starting point, to be refined)

A Vercel‑style dark TUI, three columns under a status bar:

```
┌ TOP BAR ───────────────────────────────────────────────────────────────────┐
│ ◆ autonoma · Generating your test suite        ELAPSED 06:11  ETA ~39 min  14%│
│ agent-01 · <project> · planner v0.1.7                                         │
│ ━━━━━━━━━━━━━━━━━━━━ (progress underline) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
├──────────────┬───────────────┬───────────────────────────────────────────────┤
│ AGENT        │ ARTIFACTS  N   │  ▤ AUTONOMA.md   ● WRITING LIVE   ● FOLLOWING  │
│ PIPELINE     │ tests          │  ─────────────────────────────────────────── │
│              │               │  # Acme Storefront                            │
│ ✓ Map pages  │ {} pages.json  │  E-commerce web app · Next.js + Postgres.     │
│   24 routes  │    DONE        │  ## Surfaces mapped                           │
│ ◐ Build KB   │ ▤ AUTONOMA.md  │  - /            landing                       │
│   9/24 pages │    RECEIVING   │  - /products    catalog                       │
│ ○ Model data │               │  ... (the live document — the hero)           │
│ ...          │               │                                               │
├──────────────┴───────────────┴───────────────────────────────────────────────┤
│ ▸ ACTIVITY / function calls (currently 1 line — should be a 20–30% panel)      │
│ CONTROLS / hotkey bar (currently 1 dim line — should be rich & contextual)     │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar:** brand wordmark `◆ autonoma`, run title, `agent · project · version`,
  ELAPSED, **single** ETA, progress %.
- **Left — AGENT PIPELINE:** the six steps with status icon + sub‑progress.
- **Middle — ARTIFACTS:** files produced, with status.
- **Right — HERO:** the live document (markdown/JSON), with `WRITING LIVE` /
  `FOLLOWING LATEST` indicators and scroll.
- **Bottom:** an activity feed (tool calls) + a controls/hotkey bar.

On completion: a success banner — *"Your test suite is ready — 142 tests across 24
pages."* — with a primary CTA **"CONNECT A PREVIEW & RUN →"**.

---

## 5. Interaction model

- **Full native in‑app interaction** — no shelling out, no external editor, no fallback
  prompts. Every prompt is rendered inside the TUI.
- **Keyboard (current):** `←/→` (or `h/l`) switch column focus · `↑/↓` (or `j/k`) act
  within the focused column (move a cursor, or scroll the hero) · `Enter` open · `Esc`
  back · `f` follow latest · `g/G` top/bottom · `Ctrl+C` exit (double‑press).
- **Default focus = the hero**, so the document scrolls immediately.
- **Mouse / clicks: desired but not yet implemented** (Ink has no native mouse support;
  it needs custom mouse‑tracking escape sequences + raw stdin parsing). The user
  explicitly wants clicks to work — treat as a real requirement for the proper version.

### Where the run pauses for the user (all must be self‑explanatory & clearly "action required")
1. **API key** — paste OpenRouter key (first run only; saved after).
2. **Project context** — 3 short questions (what is this project / why E2E tests / most
   critical flows).
3. **Resume?** — if a previous run exists.
4. **Continue?** — between steps (a confirm).
5. **Review & approve** — after KB, entity‑audit, scenarios: read the produced file and
   approve or send feedback (which re‑runs the agent).
6. **Recipe builder (step 5)** — per entity: review proposed test data (keep / ask the
   agent to change / edit JSON yourself), then **live UP/DOWN validation** against the
   user's locally‑running app, with retry/skip on failure.
7. **Failure recovery** — retry / retry‑with‑guidance / stop.

---

## 6. All user feedback (the comments)

Grouped by theme. Status: ✅ addressed in the prototype · ⚠️ partially · ❌ open / for the
proper redesign.

### Layout & readability
- ✅ **Terminal must not scroll the UI off‑screen.** Early builds overflowed the
  terminal height; the whole frame scrolled away. (Now every column is height‑clipped.)
- ✅ **I must be able to read the generated document.** Scrolling didn't work and threw
  me out of the UI. (Hero is now the default focus and scrolls in place.)
- ❌ **"ARTIFACTS0 tests" — the header label and count are glued together.** Needs a
  guaranteed gap / proper spacing. (Same class of bug as below.)
- ✅ **Artifact name glued to its status** ("fair‑brook‑wren‑stgRECEIVING",
  "…DONE"). Needs a clear gap; name should truncate, status sits apart.
- ❌ **Spacing/typography generally feels "put together and ugly."** Wants deliberate
  spacing, alignment, and visual polish throughout.

### Progress visibility (top priority)
- ✅ **Show the generated content front and center, live.** This is *the* improvement —
  clack hid it.
- ❌ **"No clear way of knowing it's working."** The live function/tool‑call feed is too
  small (one line at the bottom). **It should occupy ~20–30% of the bottom of the
  screen, like an IDE's output/terminal panel**, clearly streaming what the agent is
  doing.
- ✅ **Sub‑progress like "13/35".** Wanted per‑step counts (models audited, tests
  written, entities done, routes found).
- ✅ **Single ETA, not a range.** "~2h 15m–2h 50m" was unclear; show one value.

### Controls & discoverability
- ❌ **"There's no way of knowing the controls."** Wants a **rich, context‑sensitive,
  color‑coded hotkey/controls bar** at the bottom — like the reference TUIs (see §8) —
  that **changes per focus/mode** and uses color to convey hierarchy. The current single
  dim line is not enough.
- ✅ **`j/k` should work alongside arrows.**
- ❌ **Clicks should work** (mouse). See §5.
- ✅ **It's not clear which section is active** → dim the non‑focused columns. (Done, but
  the focus model + indicators should be made even clearer.)
- ✅ **Can't navigate past the currently‑running step.** (Now clamped.)

### Prompts & clarity (everything must be self‑explanatory)
- ❌ **"Continue? / Yes / No" doesn't read as requiring action.** The confirm modal is a
  huge empty box with tiny text at the top — it doesn't signal "I need you to decide."
  Modals should be sized to their content and clearly actionable.
- ❌ **"I don't understand what this is / why you need to map the models."** Pressing Esc
  surfaced a step the user didn't understand. **Every screen must explain itself** — what
  it is, why it's happening, what (if anything) to do.
- ✅ / ⚠️ **Review prompt was "too much text, looks like an exception, too narrow, and
  hid the document," and "not clear I have to give feedback."** Reworked into a **slim
  bar docked at the bottom** that keeps the document visible above it (`enter approve · i
  give feedback · esc skip`). Direction is right; copy/affordance still needs design
  love so the "action required" reads instantly.

### Rendering quality
- ✅ **Flicker when selecting text / "re‑rendering every moment."** Caused by an animated
  spinner repainting the whole tree. Removed; repaints now only happen on meaningful
  changes. Keep this constraint: **don't repaint on a timer faster than ~1s, and never
  in a way that breaks text selection.**

### Branding & chrome
- ✅ **Remove the "← SETUP" back arrow** (made no sense).
- ✅ **Show the "autonoma" wordmark** somewhere (now top‑left: `◆ autonoma`).
- ✅ **Remove the bottom‑left LOG panel** (was noise) — but note this is in tension with
  the later request for a prominent activity/function‑call panel; the resolution is a
  *useful, prominent* activity panel, not a raw log dump.

### Empty states
- ❌ **Early steps show an empty dashboard** (no artifacts yet) — needs a meaningful,
  reassuring empty state that explains what's coming.

---

## 7. Open problems for the "proper" redesign (summary)

1. **A real activity/output panel** (~20–30% height, IDE‑like) streaming the agent's
   tool calls and milestones, so progress is unmistakable.
2. **A context‑sensitive, color‑coded controls bar** that changes per focus/mode and
   communicates hierarchy with color (reference: the user's Claude Code / treemux TUIs).
3. **Self‑explanatory copy everywhere** — step purposes ("why"), prompt intent, and a
   clear "action required" treatment for anything blocking on the user.
4. **Prompt/modal redesign** — sized to content, clearly actionable; the confirm and
   review flows in particular.
5. **Spacing & typography polish** — fix glued labels/counts/statuses; deliberate
   rhythm, alignment, and color hierarchy.
6. **Mouse support** — clicking steps, artifacts, scrolling, buttons.
7. **Empty/initial states** — meaningful content before artifacts exist.
8. **Completion state** — the "test suite is ready" + "CONNECT A PREVIEW & RUN" moment,
   designed as a real call to action.

---

## 8. Reference UIs

- **The user's Claude Code / treemux TUI** (provided screenshots): note the **bottom
  bars** — they pack a lot of information, the **hotkeys change by context**, and they
  **use color to express hierarchy** (active vs inactive, primary vs secondary). This is
  the bar to emulate for controls. Examples of their bottom rows:
  - `Ctrl+B sidebar / fullscreen · F1‑F9 jump · Ctrl+O editor · Ctrl+K create PR`
  - `Enter open · 1‑9 jump · n new · r rename · y yank path · d archive · z sleep · a archived · s/S settings · q quit`
- **The original concept mockups** (Vercel‑style): the three‑column dark dashboard with
  the live document on the right, `WRITING LIVE` / `FOLLOWING LATEST` indicators, and the
  completion screen with the green success banner + CTA. These set the visual tone
  (dark, lime/chartreuse accent, monospace).

---

## 9. What's already decided (don't undo these)

- **Hero = the live generated document**, front and center.
- **Three‑column layout** (pipeline · artifacts · document) under a status bar.
- **Single ETA value** (no range).
- **Brand wordmark present; no back‑arrow.**
- **Dark theme, lime/chartreuse accent** (`#c6f24e`), monospace.
- **Review docked at the bottom** (document stays visible) — refine, don't replace.
- **Full in‑app interaction** (no external editor / fallback prompts).
- **Refresh‑from‑disk** for the live document (content appears in chunks as files are
  written; not literal character streaming).

---

## 10. Technical constraints (for whoever implements the design)

- **Framework:** [Ink](https://github.com/vadimdemedes/ink) (React for terminals), React
  18, Node ≥ 24, ESM, bundled with `tsup`, dev via `tsx`, tests via `vitest` +
  `ink-testing-library`.
- **Terminal model:** renders **inline** (not the alternate‑screen buffer). The whole
  app must fit within the terminal's row count or the terminal scrolls and the frame is
  lost — so **everything is height‑bounded**. (Switching to a fullscreen/alt‑buffer
  approach is an option worth considering for the proper version.)
- **No mouse out of the box** — Ink doesn't parse mouse events; it needs custom escape
  sequences + raw stdin handling.
- **Repaint discipline** — Ink repaints by diffing and rewriting changed lines; frequent
  repaints flicker and break terminal text selection. Keep updates to meaningful changes
  and a ~1s clock tick at most.
- **Live document** is read from disk on each write (chunked), not token‑streamed.
- **Architecture:** a framework‑agnostic run **store** holds all state (steps, artifacts,
  the live file, prompts, progress) and the Ink tree is a pure projection of it
  (`useSyncExternalStore`). Prompts use an async bridge: the orchestrator pushes a typed
  request and awaits a promise the UI resolves. There's a **headless** mode (plain line
  output) for non‑TTY / CI / `--non-interactive`.
- **Color:** truecolor accent renders on modern terminals; degrade gracefully.

### Where the code lives (current prototype)
- `src/ui/App.tsx` — layout + key handling + bottom regions
- `src/ui/Live.tsx` — binds the run store to the dashboard; owns Ctrl+C
- `src/ui/store.ts` — the run store (single source of truth) + types in `src/ui/types.ts`
- `src/ui/components/` — `TopBar`, `Sidebar`, `Artifacts`, `LiveFile` (hero),
  `render-content.ts` (markdown/JSON line styler)
- `src/ui/overlays/` — `TextPrompt`, `ConfirmPrompt`, `SelectPrompt`, `ReviewPrompt`,
  `RecipeReview`, `JsonEditor`, `UpDownFailure`, `StepFailure`, `OverlayRouter`
- `src/ui/eta.ts` — ETA model · `src/ui/nav.ts` — navigation reducer · `src/ui/theme.ts`
  — palette · `src/ui/steps.ts` — step labels/budgets
- `src/ui/fixtures.ts` + `src/ui/gallery.tsx` — a **fixture‑driven gallery** of every
  screen: run `pnpm ui:gallery` and Tab / Shift+Tab through them (no real run needed).
  This is the fastest way to see and iterate on the visuals.

### How to see it
- `pnpm ui:gallery` — step through every screen with fixture data.
- `pnpm dev -- --project /path/to/app` — a real run on a codebase (needs an OpenRouter
  key; writes output under `~/.autonoma/<project-slug>/`).
