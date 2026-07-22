# Planner TUI - Living Plan

The single source of truth for the Ink TUI rework of `@autonoma-ai/planner`.
Keep this updated as tasks complete or decisions change - long sessions lose
context, this file must not. Companion doc: `ui-design-brief.md` (same folder)
holds the full design context, user feedback, and visual decisions.

## Status

- **Branch:** `feat/cli-ink-tui`, PR #1683 targeting `main` (#1665 merged
  2026-07-22; conflicts resolved in the merge commit 70572871b).
- **Current phase:** A + B complete in PR #1683, hardened through 15 feedback
  rounds and two full homa-next runs. Mergeable; remaining items below.

## Decisions (do not re-litigate without Tom)

1. **Stacked on #1665.** The old entity-loop / discover-schema /
   full-validation / failure-classifier machinery is deleted there; we build
   on the handoff flow, not the old per-entity loop.
2. **The old worktree is a design guide, not a merge source.**
   `~/.treemux/worktrees/cli/fair-brook-wren-stg` holds a ~6.7k-line prototype
   built against CLI v0.1.7. apps/cli has diverged too far (0.1.21 + #1665)
   for a triple merge. Steal designs, layouts, component structure, and lessons;
   re-implement against current code. The prototype's `RecipeReview`,
   `JsonEditor`, `UpDownFailure` overlays target deleted machinery - drop them.
3. **Claude handoff = suspend and attach** (the `git commit` -> vim model),
   exactly as #1665 does it. No PTY wrapping (treemux proved it's deceptively
   hard: broken scrolling, added latency). No headless `claude -p` for now -
   billing is identical either way (uses the user's own claude auth), so this
   is purely a UX choice we can revisit.
4. **Store-first architecture.** A framework-agnostic run store is the single
   source of truth; the Ink tree is a pure projection (`useSyncExternalStore`).
   Prompts use an async bridge (orchestrator pushes a typed request, awaits a
   promise the UI resolves). This is what makes suspend/resume cheap.
5. **Headless mode stays.** Non-TTY / CI / `--non-interactive` gets plain line
   output; the TUI mounts only on a TTY.
6. **Serialized PRs.** One phase = one PR, landed before the next starts.
7. **ink 7 + React 19 (catalog).** ink 7.1 requires react >=19.2 and node >=22,
   both already our floors. `react`/`@types/react` come from the workspace
   catalog; ink + ink-testing-library are pinned locally.
8. **Headless = no store.** The store singleton is set only while the TUI is
   mounted; with it unset, the prompts facade and step logger fall through to
   clack/stdout, so `--non-interactive`/CI output is byte-for-byte unchanged.
9. **The dashboard mounts for the pipeline phase only** (after setup prompts,
   including `--step` runs). Setup/resume/context prompts stay plain clack in
   Phase A; they move in-TUI in Phase B.
10. **Visual identity:** dark, lime/chartreuse accent (see `src/core/colors.ts`
    - brand accent already exists), monospace, three-column dashboard, hero =
    the live generated document. Single ETA value, no ranges.

## Design north star

At every moment the user knows: what's happening now, what's been produced,
how far along / how long is left, and whether anything is asked of them - and
they can read the generated work live. Full principles + all user feedback:
`ui-design-brief.md` sections 2 and 6-7.

---

## Phase A - Foundation + live dashboard (PR 1)

The TUI shell, store, and the three-column dashboard with live streaming for
the pipeline agents. Clack prompts and the claude handoff keep working by
suspending the TUI around them (overlays come in Phase B).

### Tasks

- [x] Deps: `ink`, `react`, `ink-testing-library`, `@types/react`
      (prototype used ink 5 + React 18; evaluate ink 6 + React 19 to match the
      workspace catalog react - decide and record here).
- [x] `src/ui/store.ts` + `src/ui/types.ts` - run store: steps, sub-progress,
      artifacts, live file, activity feed, elapsed/ETA, focus/nav state.
- [x] `src/ui/theme.ts` - palette derived from `src/core/colors.ts`.
- [x] `src/ui/steps.ts` - step labels (plain-language, self-explanatory "why"
      copy per design brief §3) + time budgets for the ETA model. Must reflect
      the post-#1665 pipeline: pagesFinder, kb, entityAudit, scenarioRecipe,
      recipeBuilder (handoff), testGenerator.
- [x] `src/ui/eta.ts` - elapsed + single-value ETA from budgets + sub-progress.
- [x] Dashboard screen: top bar (wordmark, elapsed, ETA, %), pipeline column
      (steps + sub-progress), artifacts column (status PENDING/RECEIVING/DONE,
      spacing bugs from brief §6 fixed), hero document viewer (markdown/JSON
      line styling, scroll, follow-latest), activity panel (~20-30% height,
      IDE-like, streaming tool calls).
- [x] Keyboard nav: arrows + hjkl, focus model with dimmed inactive columns,
      g/G, f follow, Esc, double-Ctrl+C exit. Context-sensitive controls bar.
- [x] Event bridge: `core/agent.ts` step events + `core/display.ts` tool-call
      summaries feed the store instead of printing (TTY mode). `toolCallSummary`
      logic is reused, not duplicated.
- [x] Artifact watcher: refresh-from-disk for the live document (chunked, not
      token-streamed), ~1s max repaint cadence, no timer-driven spinners
      (flicker/selection constraint, brief §10).
- [x] Suspend/resume: wrap every remaining clack prompt and the #1665 handoff
      (`core/interrupt.ts` suspend/resume) in TUI unmount -> run -> remount.
- [x] `src/ui/gallery.tsx` + fixtures - fixture-driven gallery of every screen
      (`pnpm --filter @autonoma-ai/planner ui:gallery`), the fast visual
      iteration loop.
- [x] Headless fallback: non-TTY keeps current line output; `--non-interactive`
      unchanged.
- [x] Tests: store transitions, ETA model, nav reducer, render smoke tests via
      `ink-testing-library`.
- [x] Update `apps/cli/README.md` + `CLAUDE.md` (UI architecture section).

### Feedback round 1 (Tom, gallery screenshot, 2026-07-21)

- [x] Higher-contrast column separators / panel hairlines (theme border tokens
      brightened).
- [x] Responsive column geometry: fixed widths matched the design at ~140 cols
      but let the hero swallow wide terminals; columns now grow proportionally
      (22% / 27% / rest). Empty-state copy is wrapped and centered as a block.
- [x] Navigation actually testable in the gallery: scenes are live stores now
      (cursor `›` + selection highlight in pipeline/artifacts columns, fixture
      reader serves canned content), and `pnpm ui:gallery <dir>` adds a scene
      backed by a real output directory (e.g. ~/.autonoma/<slug>) with real
      files read from disk.
- [x] Link to what's happening: STEP_DOCS maps steps to docs pages
      (recipeBuilder -> environment-factory, testGenerator -> test-planner),
      shown in the empty-state hero.
- [x] Docs refreshed: test-planner page now covers the 7-step pipeline, the
      live dashboard, and the coding-agent handoff for step 6 + new flags;
      environment-factory index gets a "let the planner wire it for you" tip.

### Feedback round 2 (Tom, real-dir gallery run, 2026-07-21)

- [x] Performance (~3fps -> smooth): rows render as single pre-styled ANSI
      strings (was thousands of nested <Text> spans per frame), renderContent
      is memoized on (text, kind, name), and store notifications coalesce to
      one repaint per 16ms burst.
- [x] Document-aware rendering: markdown frontmatter renders as an info card
      (scalars as key/value, arrays like AUTONOMA.md's pages/core_flows as
      two-column tables); pages.json renders as a route table (route,
      description, dim path). Unknown JSON keeps syntax highlighting; broken
      frontmatter falls back to raw markdown.
- [x] "RECEIVING" renamed to "WRITING" everywhere (matches "WRITING LIVE").
- [x] Help modal on `?`: what the current step is doing (shares STEP_INTROS /
      STEP_SUMMARIES with the orchestrator - moved into ui/steps.ts), the docs
      link, pipeline overview with live statuses, and the key reference.
      `?`/esc/q close; keys are swallowed while open; hint added to the
      controls bar.

### Feedback round 3 (Tom, 2026-07-21)

- [x] Layout: the vertical pipeline column read as a fake Finder-style
      hierarchy next to the file list. The pipeline is now a HORIZONTAL strip
      under the top bar (status-only, not focusable - selecting a step did
      nothing), with a braille spinner on the running step (frame keyed to
      state.now, advances on repaint - no dedicated timer). The file list
      (renamed FILES) sits on the left at its old width; the viewer takes the
      rest. Two focus regions remain: files and document.
- [x] Right from the file list = open the selected file (same as enter),
      Finder-style. Left from the document lands the cursor on the open file.
- [x] The file list no longer jumps back to tailing the newest write while
      the user is browsing or has a file pinned - the selection stays in view.

### Feedback round 4 (Tom, 2026-07-21)

- [x] Slow to become interactive: the gallery now paints immediately and the
      real-directory scene loads async (slots in as scene 1 when ready); its
      file stats run concurrently instead of one await per file. Note: most of
      the remaining dev-mode delay is tsx cold-compiling ink/react - the
      published CLI is tsup-bundled and doesn't pay it.
- [x] Esc goes back to the file list from the document.
- [x] Nested test folders (qa-tests/<area>/<sub>/...): each test shows its
      folder path as the description line, so same-named tests in different
      folders stay distinguishable. No tree view for now.
- [x] Exit leaves a clean terminal: the dashboard frame is cleared on every
      unmount (Ctrl+C, completion, failure) and the gallery clears on quit.
      Post-exit messages (resume hint, outro) print on the clean screen.

### Feedback round 5 (Tom, 2026-07-21)

- [x] Default focus is the FILE LIST (not the viewer): arrows give visible
      feedback immediately. While following, the cursor rides the newest
      written file; moving it (or opening a file) stops following until `f`.
- [x] Fixed the dead/jumpy arrows in the viewer: while following, the view
      sits at the tail but the scroll counter was 0, so the first keypress
      jumped to the top (or did nothing visibly). The layout now reports the
      viewer height to the nav reducer (setViewport) and unfollowing starts
      scrolling from the tail position actually on screen; scrollBottom/G use
      the same exact bound. Opening a file explicitly starts at the top.

### Error surfacing (Tom's question, 2026-07-21)

- [x] Fatal crash while the TUI is mounted no longer vanishes: mount registers
      an emergency teardown (core/ui-lifecycle.registerUiTeardown); the
      main() fatal catch and the uncaughtException/unhandledRejection
      diagnostics tear the frame down (restoring the real console) BEFORE
      printing, so the error lands on a clean terminal.
- [x] A failed/paused finish shows red "stopped" / amber "paused" in the top
      bar with the real percentage - only a successful finish reads
      "complete / 100%".
- [x] Errors stay reviewable: the "?" modal gains a RECENT PROBLEMS section
      (last 4 warn/error log lines) since activity rows scroll away. Step
      failures still land as red rows + the retry ACTION REQUIRED panel.

### Feedback round 6 (Tom, first solo run, 2026-07-21)

- [x] The hero now properly explains the running step: STEP N OF 7 eyebrow,
      label, the full "what and why" intro, "Produces <file> - <what it is>",
      and the docs link. No more bare "X is starting".
- [x] Spinner runs forward at a constant pace: the store clock ticks every
      250ms and the spinner frame period matches it exactly (the old 1s tick
      against a 120ms frame period made it crawl backwards).
- [x] Prompts are a BIG centered ACTION REQUIRED modal over the dashboard
      (the docked bottom panel was barely visible). Activity stays drawn
      beneath it.
- [x] Esc NEVER exits the run. Default prompts ignore esc (with an inline
      "Ctrl+C twice quits" hint); flows with a previous question mark
      themselves cancelable and esc goes BACK (backends -> frontend pick,
      guidance -> failure choices, ask-user -> skip). The scope flow loops.
- [x] Multiselect explains itself: "Pick EVERY backend ... you can select
      several", pre-checked note, and the key line reads "space toggle
      on/off · enter confirm selection".
- [x] Agent echo spam decoded: toolChoice:"required" forces a tool call per
      turn, so the model wraps its commentary in `bash echo ...`. Those rows
      now render as dim "agent" notes with the echoed text (empty echoes
      dropped) instead of a wall of bash lines.

### Agent-loop fix exposed by the TUI (2026-07-21)

- [x] The "disaster" spam was real agent waste the old scrolling logs hid:
      project-mapper and pages-finder never had a `finish` tool, while their
      prompts and stop conditions (hasToolCall("finish")) demanded one - so
      every run burned to the step cap (mapper 60, pages 150 + 2 nudge
      regenerations) with the model flailing `echo` no-ops. Both agents now
      have gated finish tools (mapper requires set_project_map first; pages
      requires at least one add_page) and pages-finder's extractResult
      actually reflects completion. Bare `echo` in the bash tool is also
      short-circuited with a "call finish" reminder instead of executing.

### Feedback round 7 (Tom, second solo run, 2026-07-21)

- [x] Between-steps "Next: ... Continue?" confirms removed entirely - the
      pipeline flows step to step (review checkpoints and failure prompts
      remain the only stops).
- [x] Modal corruption fixed at the root: that confirm's message carried a
      literal newline, and a control char inside a grid cell breaks the
      emitted row and shifts every terminal line below it. Grid.set now
      sanitizes control chars to spaces (regression-tested) and the wrap
      helpers split on all whitespace.
- [x] Pending steps in the strip were near-invisible (#444): glyph ->
      tertiary, label -> secondary.
- [x] Esc ladder completes: document -> file list -> step explainer
      (closeDocument clears the viewer; f re-follows).
- [x] The explainer tells users how to open files once any exist ("Press
      enter or -> on a file in the list to read it here.").

### Feedback round 8 (Tom, 2026-07-21)

- [x] Broken activity rows: multi-line tool args (subagent prompts,
      register_pages payloads) are flattened to one line in the bridge, and
      the grid-level control-char sanitize (round 7) stops any stray newline
      from shifting the frame. Long tool names (register_pages) no longer
      bleed into the arg column (verb clamped to its 11-col cell).
- [x] project-map.json renders structured (like pages.json): frontends /
      backends / ignore as labeled sections with path + why tables and
      dim annotations (framework, dependsOn, dataLayer). Also fixed a bad
      esc-ladder test that shipped red in the previous commit.

### OOM + input lag on a real client repo (Tom, 2026-07-21)

- [x] Heap exhaustion at the 4GB default: agent tool results are retained in
      the step's conversation, and three tools were unbounded - read_file had
      a line cap but no byte cap (a one-line minified bundle/lockfile passes
      at megabytes), glob returned unlimited match arrays, list_directory
      unlimited trees. All capped at the boundary now: read 256KB with a
      "request a smaller range" note, glob 500 matches + narrow-the-pattern
      note, tree 128KB; glob also ignores .next/build/coverage.
- [x] The dead arrows were the same bug seen from the other side: ~1s
      mark-compact GC pauses under heap pressure blocked the event loop, so
      keypresses queued. With bounded tool results the pauses go away.

### ETA heuristic data (PostHog, 2026-07-21)

Measured from cli_step_completed (status=done, 90 days, project 233600;
1129 runs started / 302 completed / 178 distinct users). Seconds:

| step           | n   | p50  | p75  | p90   |
|----------------|-----|------|------|-------|
| projectMapper  | 23  | 157  | 277  | 462   |
| pagesFinder    | 142 | 147  | 276  | 595   |
| kb             | 114 | 595  | 1440 | 2994  |
| entityAudit    | 105 | 442  | 1429 | 4373  |
| scenarioRecipe | 98  | 92   | 429  | 794   |
| recipeBuilder  | 43  | 115  | 471  | 1699  | (pre-handoff era)
| testGenerator  | 40  | 1767 | 3580 | 11317 |

- [x] STEP_BUDGET updated to ~p60 of these (kb 12m, audit 10m, tests 30m...).
- [x] Size signals now instrumented on cli_step_completed for future
      regression heuristics: frontend/backend/ignored counts (mapper),
      page_count (pages/kb/tests), entity_count (audit), test_count (tests).
      Historical events carry no size data - the dataset starts accruing at
      the next release.
- [x] Mapped on the Planner CLI dashboard (id 1647172): "Step duration
      percentiles (min)" (insight 36knd1LB - p50/p75/p90 bars per step; p50
      drives STEP_BUDGET) and "ETA heuristic dataset: duration vs size"
      (insight Qd9o9ado - raw rows of duration + page/entity/test/
      frontend/backend counts; size columns populate from the TUI release).
- [ ] Later: regress duration on page_count/entity_count once enough data
      accrues (the Qd9o9ado table is the dataset); and/or scale remaining
      budgets by this run's actual-vs-budget ratio (adaptive ETA).

### The 4GB OOM, root-caused (2026-07-21)

Both crashes died ~4.5 minutes in regardless of pipeline step - a steady
~35MB/s bleed. Soak-tested the TUI with no agents (tmux TTY, forced-GC
sampling) and bisected: store flat, raw Ink flat, grid computation flat -
the leak was **passing the Grid object as a React prop to GridView**
(~2MB retained per render, permanently). Fixes:

- [x] Grid rendering inlined into Dashboard (GridView deleted); full-mount
      soak now flat at 24MB where it previously hit 1.9GB in 60s. Invariant
      documented in CLAUDE.md: never pass large per-render objects as props.
- [x] Handler identities stabilized (Live/gallery useCallback) and no-op
      store dispatches no longer emit - kills a secondary render feedback
      loop through the setViewport effect.
- [x] The published CLI now defaults NODE_ENV=production before react/ink
      load (it was running React's dev build).
- [x] pages-finder path bug: PageCollector resolved paths against the CLI's
      own cwd, rejecting honest project-relative paths until the model
      brute-forced ../-chains to filesystem root; now resolves against the
      target projectRoot and stores project-relative paths.

### Feedback round 9 (Tom, 2026-07-21)

- [x] Review checkpoints removed entirely (core/review.ts deleted): no more
      open-in-IDE picker, no feedback loop, no press-enter-to-approve. The
      TUI is the review surface; failure prompts remain the only mid-run
      stop. Docs updated.
- [x] Document viewer wraps long lines: span-aware word wrap at the hero
      width (renderContentWrapped, memoized on width); scroll bounds count
      folded lines (viewport cols reported alongside rows).
- [x] Wall time vs agent time: elapsed and ETA freeze while a question modal
      is up (waitedMs banked per prompt; step startedAt recorded in agent
      time; strip spinner freezes too; ACTIVITY header reads "waiting for
      you").

### Feedback round 10 (Tom, third solo run, 2026-07-21)

- [x] FILES list is newest first: new files register at the top (the file
      being produced sits where the eye starts); while following, the window
      pins to the top. Test files stream in at the top during the last step.
      Deliberately stable on rewrite - a re-touched older file shows its
      WRITING chip in place rather than jumping the list around.
- [x] Stuck "WRITING" fixed: a later step re-touching an earlier step's file
      (kb updating pages.json coverage) flipped it to WRITING with nothing to
      ever settle it - its own endStep had already run - while the viewer
      header (write-settle driven) said COMPLETE. The write-settle timer now
      also returns the artifact to DONE when its owning step is not running.

### Feedback round 11 (Tom, 2026-07-21)

- [x] Dead factory-scaffold.ts removed from the entity-audit prompt: nothing
      has consumed it since the claude-handoff rework (the coding agent
      implements factories straight from entity-audit.md), so the agent was
      burning steps writing a file nobody reads. entity-audit.md is now the
      single output, and the prompt says explicitly it must be precise enough
      to implement factories from.
- [x] Pre-handoff countdown: before the terminal switches to the coding
      agent, a 10s "UP NEXT" modal explains what is about to happen (terminal
      switches, dashboard disappears, planner resumes automatically when the
      agent exits). Enter continues immediately; auto-continues at zero.
      Generic store countdown (runCountdown/skipCountdown) + p.countdown
      facade (headless prints and continues). Gallery scene added.
- [x] entity-audit.md document-aware rendering: the huge models frontmatter
      renders as a table - model name, "● factory <creation_function>" vs
      "○ via <owners>", with the creation file / side effects / why as a dim
      second line, plus a factory/owner summary header. Zod-validated per
      model; falls back to the generic card when the shape is off.

### Feedback round 12 (Tom, first full handoff run, 2026-07-21)

- [x] The handoff never returned: interactive Claude Code finishes the task
      but sits at its REPL - it never exits, and launch() only resolved on
      process exit. The completion marker is the real done signal, so the
      launcher now polls for it while the agent runs (2s), waits a 30s grace
      for the closing summary to stream, then SIGTERMs (SIGKILL after 10s)
      to reclaim the terminal. Stale markers are deleted before every launch
      so they can't fake success or trigger an instant reclaim; the
      integration prompt (v4) tells the agent the planner watches the marker
      and to keep the closing summary brief.
- [x] recipe.json.tmp.<pid>.<hash> atomic-write droppings no longer register
      as artifacts (isInternal filters .tmp names) - they were lingering as
      ghost DONE rows after the rename.
- [x] Test files sort alphabetically (by path, so folders group) in a block
      at the top of the FILES list; pipeline files stay newest-first below.
      The list window now always keeps the selection in view - while
      following, the cursor rides the newest write, which sits mid-list in
      alphabetical order. toggleFollow picks "newest" by updatedAt, not list
      position.
- [x] The integration prompt instructs the agent to end with one short
      closing message - "the planner takes this terminal back in a few
      seconds; exit now to continue immediately" - and nothing after it.

### Feedback round 13 (Tom, tests-step run, 2026-07-22)

- [x] WRITING is now transient (supersedes the round-10 rule): a file settles
      to DONE ~1s after its write quiets, even while its step runs. The old
      rule kept every test glowing WRITING for the whole hour-long step and
      the "N ready" count frozen. A later update flips a file back to WRITING
      for the burst. (No separate PLANNED state needed: files only ever enter
      the list at their first actual write.)
- [x] Follow state made prominent in the step explainer: "● following - the
      newest file opens here as it's written" (accent) when live-tailing, or
      an accent-chip " f  follow the newest file..." hint when paused. The
      hero header shows "pinned · f follows latest" when a document is open
      un-followed.
- [x] Adopted the two pieces of PR #1701 our finish-tool fix (b3ac752f3)
      lacked: the test-generator review-fix loop no longer force-nudges after
      a clean pass (extractResult returns the already-set result), and the
      pages-finder prompt no longer encourages re-listing directories.

### Feedback round 14 (Tom, 2026-07-22)

- [x] Project-mapper consistency: the backend options varied run to run (3-5
      backends on the same repo) because enumeration was pure LLM sampling.
      Two-part fix: (a) the prompt now mandates INVENTORY -> CLASSIFY (build
      the member list mechanically from workspace manifests + top-level dirs,
      then classify every entry; workers/API-only services/gateways called
      out as backends; ignoring is an explicit decision) and (b) a mechanical
      backstop - set_project_map walks the repo (findUncoveredDirs, depth 2,
      skipping dot/build dirs) and returns any directory no entry accounts
      for; finish refuses while holes remain, and coverage gates the nudge
      loop. Verified against the real homa-next repo + map.

### Feedback round 15 (Sponja via PR review, 2026-07-22)

- [x] Removed the bare-`echo` interception from the bash tool. It was a
      crutch from the era when agents could not terminate (no finish tools)
      and it lied about execution; with real finish tools everywhere the
      motivation is gone, and the heuristic could swallow legitimate
      commands. Plain echo now just runs. The display-side rendering of pure
      echo as agent narration (cosmetic only) stays.

### Verification

- [x] `pnpm --filter @autonoma-ai/planner typecheck && test && build`
      (single-package only - never full-repo builds locally).
- [x] Gallery pass over every screen.
- [x] Real run (tmux-driven, homa-next, prod API token, 2026-07-21): mount ->
      resume panel -> declined -> 3 text questions typed -> project mapper
      streamed live (spinner, ETA, activity) -> scope select + multiselect
      (space toggle verified) -> continue confirm -> opened project-map.json
      in the viewer -> help modal mid-run -> Ctrl+C arm hint -> clean exit +
      resume hint -> --resume seeded the strip and continued. Three bugs
      found and fixed: stale "running" seeded a ghost spinner (seed only
      settled statuses), declining resume didn't reset persisted state (now
      resets), late fs-watcher registrations stayed WRITING forever (now land
      DONE).
- [x] Handoff suspend/resume on a real run (homa-next, 2026-07-22): TUI
      suspended, Claude Code implemented all 20 factories and validated the
      recipe, and after a manual exit the planner resumed into test
      generation. Found on that run: the interactive session never exits on
      its own -> the completion watcher (round 12).
- [x] The round-12 auto-reclaim path live: Tom observed it twice on real runs
      (came back to the CLI already past the handoff, building tests, without
      manually exiting Claude Code).

## Phase B - In-TUI prompts, clack removed (in PR #1683)

Decision (Tom): fold Phase B into the same PR and remove @clack entirely -
the only terminal handover left is the claude handoff.

- [x] Async prompt bridge in the store (typed request -> promise, FIFO queue,
      terminal bell on activation). Pure editing logic in `ui/prompt.ts`
      (draft init / reducer / answerFor).
- [x] All four prompt kinds as the docked ACTION REQUIRED panel (replaces the
      ACTIVITY region while blocked; document stays readable): confirm
      (yes/no chips, y/n hotkeys), select (windowed list), multiselect
      (checkboxes, space toggles, required -> inline error), text (caret,
      sliding window, placeholder). Covers resume?, project context, scope
      selection, continue?, step failure, review, ask-user, handoff prompts.
- [x] Panel sizes to the bottom region, shows its own per-kind key line, and
      a queue counter ("+N more after this"); nav hints hide while blocked.
- [x] @clack/prompts + @clack/core removed from the package; the facade
      (`ui/prompts.ts`) has its own CANCEL sentinel. Headless (no store):
      plain console log lines; blocking prompts resolve to their safe default
      or CANCEL. interrupt.ts dropped the readline patching (clack-only).
- [x] Dashboard mounts BEFORE the setup questions - the entire interactive
      run happens inside the TUI now.
- [x] Bell on prompt activation (+ notify() on step failure, pre-existing).
- [x] Empty states for early steps (done in feedback round 1).
- [x] Completion: plain-text summary + "connect a preview" CTA printed after
      the cleared dashboard (a full Done screen was dropped - the frame is
      cleared on exit by design, so scrollback gets text, not a banner).

## Phase C - Polish (PR 3)

- [ ] Human names for generated files (Tom, 2026-07-22): the raw filenames
      are useless to a user - show a proper title as the primary label with
      the filename demoted to the dim secondary line, and richer descriptions
      where useful. E.g. AUTONOMA.md -> "Knowledge Base", entity-audit.md ->
      "Database Entity Analysis", project-map.json -> "Project Map",
      pages.json -> "Page Inventory", scenarios.md -> "Test Data Scenarios",
      recipe.json -> "Test Data Recipe", INDEX.md -> "Test Suite Index";
      test files keep their (already descriptive) kebab names. Display-only:
      on-disk names are contracts (downstream agents + the handoff prompt
      reference them) and must not change. Lives in ui/artifacts/registry.ts
      (title + description per known file), plus the hero header showing the
      title next to the filename.
- [ ] Spacing/typography sweep (glued labels, alignment, rhythm - brief §6).
- [ ] Color-coded, context-sensitive controls bar (reference: Claude Code /
      treemux bottom bars, brief §8).
- [ ] Truecolor degradation, narrow-terminal behavior, min-size handling.

## Phase D - Mouse support (PR 4)

- [ ] Custom mouse-tracking escape sequences + raw stdin parsing (Ink has no
      native support). Click steps/artifacts to select, click buttons in
      overlays, wheel-scroll the hero.
- [ ] Must not break text selection when disabled / degrade cleanly.

---

## Key integration points (current code)

- `src/index.ts` - orchestrator; owns clack flow today; will mount the TUI.
- `src/core/agent.ts` - `onStepFinish`-style step events (source for activity
  feed + sub-progress).
- `src/core/display.ts` - `createStepLogger` + `toolCallSummary` (reuse
  summaries; TTY path redirects into the store).
- `src/core/interrupt.ts` - suspend/resume used by #1665's handoff; the TUI
  hooks the same seam.
- `src/agents/04-recipe-builder/phases/handoff.ts` (#1665) - the attach flow
  the TUI must suspend around.
- `src/tools/ask-user.ts` - agent-initiated questions -> prompt bridge (B).
- `src/core/state.ts` - pipeline state for resume screen.

## Open questions

- Does this PLAN/doc pair stay in the final PR or get dropped before merge?
  (Tom leaning: keep updated during dev; decide at PR time.)
- (resolved) ink 7 + React 19 from the catalog - Decision 7.
- (resolved) Inline rendering, one row shy of terminal height; no alt-buffer.

## After-merge / follow-ups

- [x] PR #1683 title + description rewritten to cover the full scope
      (2026-07-22).
- [ ] ETA heuristic v2: once the Qd9o9ado PostHog dataset accrues, regress
      step duration on size counts (pages/entities/tests) and scale remaining
      budgets by the run's actual-vs-budget ratio (adaptive ETA).
- [x] #1701: Sponja closes it when this merges (this branch supersedes it).
- [ ] npm release: publish a canary from main post-merge and smoke it on a
      client repo before tagging @latest.

## Prototype file map (for reference while porting ideas)

`~/.treemux/worktrees/cli/fair-brook-wren-stg/src/ui/` - App.tsx, Live.tsx,
store.ts, types.ts, eta.ts, nav.ts, steps.ts, theme.ts, grid.ts,
components/ (GridView, render-content), screens/ (Dashboard, Splash,
Checkpoint, Done, Resume, Validate, Recipe, Context, KeyCard, FailCard),
overlays/ (OverlayRouter, Confirm/Select/Text/Review prompts, StepFailure,
common; RecipeReview/JsonEditor/UpDownFailure are obsolete), artifacts/
(watcher, reader, registry), draw/ (chrome, dashboard, paint, recipe,
standalone, validate), hooks/ (useStore, useTerminalSize), plus
tests/ui/ and tools/ (ansi-html, snap.py, render-scene) for snapshot tooling.
