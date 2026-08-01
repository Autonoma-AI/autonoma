# Docs screenshot plan

Tracking document for adding a third image tier - **product screenshots** - to `apps/docs`. Not published: Astro only serves `src/content/docs/` and `public/`.

## The three tiers

| Tier | Answers | Source |
|---|---|---|
| **Hero** (atmospheric) | "what is this section about" | generated art, `create_image` |
| **Diagram** (labeled) | "how does this flow / relate" | generated art, `create_image` |
| **Screenshot** (new) | "what is the actual thing I will operate, and how do I know it worked" | Storybook + `storybook:shoot`, or the CLI gallery |

A screenshot earns its place only when the reader must **find and operate a surface**, must **recognise an output**, or is **choosing between two paths the UI makes obvious**. Diagrams stay wherever the subject is a flow, an algorithm, or a relationship across systems - a screenshot cannot show a topological sort or a five-system loop.

Default to a **zoomed crop or a component-only render**. A full dashboard screenshot at docs width is noise. Full page only when the frame itself is the point (e.g. one screen containing two competing paths).

Every image needs **descriptive alt text**. `llms.txt` / `llms-full.txt` are generated at build time and an image degrades to its alt text, so alt text is the entire value of the image to an agent. "The Variables step with a secret row selected, showing the masked value and the Replace value button" - not "screenshot of the variables page".

## Capture mechanics

**UI** - `pnpm --filter @autonoma/ui storybook`, then `storybook:shoot -- --story <id> --viewport WxH`. Confirm story ids against `curl -s localhost:6006/index.json`; a wrong id silently shoots Storybook's error page.

> **Always start Storybook with `VITE_API_URL=https://api.autonoma.app` for docs shots.** Storybook runs on localhost, and `getApiOrigin()` (`apps/ui/src/lib/api-origin.ts`) returns `env.VITE_API_URL` there - so any screen that renders an endpoint bakes `http://localhost:4000` into the image. The MCP config screen shows the whole `claude mcp add` command, so an unset env teaches readers the wrong URL. Check the frame for dev hostnames before shipping any shot.

**Framing lesson from the first page.** A full-page 1440x900 shot renders at ~768px in the docs content column - a 53% downscale that makes body text unreadable. Cropping the nav rail and top bar off before shipping brought the same shot to ~72% and made the pairing code, step headings and controls legible. Treat "full page" as meaning "the whole content area", not "the whole browser". Never put an image inside a numbered list item either - it inherits the list indent and shrinks further.

**Padding belongs in the story, not the crop.** Give each story's decorator a generous `p-14` and a `bg-surface-void`, shoot at the decorator's own max-width, and crop **only the dead space below the component**. Never trim the left, right or top edge - `sharp.trim()` removes uniform borders, which means it eats exactly the padding the decorator just added, and then the content sits flush against the image border no matter how much you extend afterwards. This cost three rounds to spot.

**Page stories have no decorator to hang padding on**, since they render the real app shell. There the crop carries the margin: pick the content rectangle by eye from a full capture, subtract the margin from `left`/`top` and add twice it to `width`/`height`. Where the page's own whitespace is thinner than the margin you want, `extend` the canvas with the page background sampled from an empty region of the same shot - that is safe here precisely because there is no decorator padding for a trim to eat.

One trap when you add that padding: it comes out of the content width, so `max-w-4xl` minus `p-14` leaves 784px and drops the component below the `lg` breakpoint - which silently collapsed the Build spec rail into one column. Widen the decorator (`max-w-5xl`) so the padding does not change which layout renders, and check the shot still shows the same layout a user sees.

**The old approach, kept only as background:** `.docs-content img` renders at 100% of the ~768px content column and draws a 1px border, so content flush to the edge reads as cropped rather than framed - and sits oddly next to the generated diagrams, which have their own internal margin. Pad to `--surface-base` (`#0a0a0a`), the colour the image slot already sits on, so the padding is invisible and only the breathing room shows.

**And check the component is not clipped.** These are viewport screenshots, so a component taller than `--viewport` is silently cut mid-control - the first cut of `build-manual.png` lost the bottom of the Entrypoint field. After trimming, if the content height equals the viewport height the shot ran off the bottom: reshoot taller. Target ~56px rendered padding; anything less reads as cropped on a dense component.

Scale the pad to the *rendered* size, not the pixel size: a 2x terminal capture is ~2150px wide and a component crop ~880px, but both render at ~768px, so a flat pixel pad lands at wildly different sizes on the page. `pad = round(56 * max(1, width / 768))`. Trim the image first so the step is idempotent and captures from different paths end up equal.

The shoot script has **no `--clip` and no `--selector`** (`apps/ui/scripts/storybook-screenshot.ts`), so framing comes from two places: sizing `--viewport` to the component, and a decorator that constrains it (`mx-auto max-w-4xl p-8` is the established pattern). Crop afterwards with `cwebp -crop x y w h`, as the README assets do. Wiring `--clip` into the script is ~15 lines and worth doing if we end up wanting many tight sub-panel crops.

Component stories render **without the app shell by default** - `StoryShell` gives theme, toasts, a QueryClient and a memory router, nothing else. Only `parameters: { pageStory: true }` pulls in the real route tree and its sidebar.

Images go in `apps/docs/public/img/<section>/<name>.jpg`, referenced as `/img/<section>/<name>.jpg`. Existing docs art is `.jpg`; **screenshots should be `.png`** - JPEG chroma subsampling smears thin UI text and monospace glyphs on dark backgrounds. Both are LFS-tracked, so PNG costs nothing extra.

**CLI** - `pnpm --filter @autonoma-ai/planner ui:gallery` renders the real TUI against canned fixtures (7 scenes, no repo/token/network). Capture is a manual terminal screenshot today; there is no `vhs`/`asciinema`/`freeze` anywhere in the repo. Crop off the gallery's own footer (`Scene 3/7 · … Tab next`) - that is harness chrome, not product. Size the terminal generously first: the layout is responsive and a cramped terminal misrepresents the UI.

> **Open question before doing any CLI image.** `apps/cli/tests/ui/render.test.tsx` already renders any scene to a full ANSI frame headlessly at a fixed size. That means a **code block** is essentially free, reproducible in CI, and readable by agents as text - while an image needs new ANSI-to-image tooling (~half a day) to be reproducible at all. Decide code block vs image before building anything.

## Blocked on doc/code drift

Several screenshots would visibly contradict the page they sit on. Fix the text (or the product) first. These are worth fixing on their own merits, screenshots or not.

| # | Where | Problem | Status |
|---|---|---|---|
| D1 | `preview-environments/*` (whole section) | Not one page mentions the MCP/agent path, but `AgentGate` makes the pairing screen the **default** for preview setup; the manual stepper is a demoted link | [x] overview now leads with the agent path and links it |
| D2 | `preview-environments/hooks.md` | Page says pre-deploy = seed data, post-deploy = migrations; the product's own copy says the opposite. Page also says a hook "belongs to the preview, not any single app" but the UI requires an App per hook | [ ] |
| D3 | `preview-environments/apps.md` | Documents a **Health check** field in the app card; no editable control exists (read-only in `preview-taking-shape.tsx`) | [x] fixed |
| D4 | `preview-environments/index.md` | "three required steps" - there are four; the terminal **Review** step owns the deploy button. "Per-row toggle to mark a value as a secret" is really a Secret/Connection segmented control | [x] fixed |
| D5 | `preview-environments/databases.md` | "move any task to whichever bucket fits" - no such control; frequency is fixed by which group's *Add task* you pressed. "Redis / Valkey" is two engine cards | [x] fixed |
| D6 | `test-planner/index.mdx` | Describes a three-column TUI ("steps left, files middle, document right"). Ships as a horizontal step strip over two panels | [x] fixed |
| D7 | `reference/scenario-recipe-schema.md` | Quotes two error strings that no longer match the code | [ ] |
| D8 | `apps/ui` scenarios `ConfigureWebhookDialog` | Placeholder says `/api/scenarios`; docs say the conventional path is `/api/autonoma` | [ ] |

## Screenshots

Priority is the reader's, not ours: HIGH = readers get stuck without it.

### `mcp/configure-preview.mdx` - doing this one first

| # | Heading | Shot | Framing | Story | Status |
|---|---|---|---|---|---|
| M1 | `## Start from the Autonoma UI` | The agent-first PREVIEW step: pairing code, install snippets, idle cube, and the demoted "Answer a few questions instead" link | content area, nav cropped - the frame contains **both paths**, which is the point. `1120x900` | `onboarding-previewenvironmentstep--agent-first` | [x] `configure-preview-ui.png` |
| M2 | intro, under the hero | The manual wizard's step rail + top of the Apps step - "six steps of fields", not the fields | zoomed crop | none - new page story at `?configStep=apps` | [ ] deferred, needs a new story |
| M3 | `## How the agent sets Autonoma up` (end, beside the read-only paragraph - **not** replacing `configure-preview-flow.jpg`) | Read-only agent screen: Take over, live tool-call stream (`pair`, `get_config`, `apply_config`), chosen path, config so far, deploy status | `960x660` crop - the Preview path card made it taller than the old `535` | `onboarding-agentconfiguringscreen--configuring` | [x] `agent-configuring.png` |
| M5 | `preview-environments/your-own-deploys.md`, `## Verifying it works` | The connect-your-deploys step: provider tiles, what-the-workflow-does, the five-step strip, and the sticky signal gate | `1280x870` - wide enough for all four tiles, tall enough that the strip clears the sticky bar | `onboarding-existingdeploys--custom-setup-guide` | [x] `preview-environments/connect-your-deploys.png` |
| M4 | `## Secrets stay yours` (**below** `secrets-flow.jpg`, not instead of) | The env-request form: agent's note per key, input rows, "I don't have this", paste-`.env` | panel only, `914x264` | `onboarding-agentenvrequest--pending-env-request` | [x] `env-request.png` |

**Why not a side-by-side for MCP vs manual.** The two paths are alternatives, not stages, so before/after is semantically wrong. A composite would fight the image system (very different aspect ratios) and would need re-shooting as a unit whenever either screen changed. Most importantly the fork is **already inside M1's single frame** - the product stages the choice itself, with its own hierarchy. One shot per path, each anchored to the sentence that describes it.

### `test-planner/index.mdx`

| # | Heading | Shot | Framing | Source | Status |
|---|---|---|---|---|---|
| T1 | `## Watch it work` | The TUI mid-run - replaces both prose paragraphs, and forces D6 to be fixed | full terminal | gallery scene `mid` | [x] `tui-dashboard.png` |
| T2 | `## Run it` | Finish setup → Upload test artifacts: the copyable command + the "what it generates" checklist | zoomed crop | new export on `finish-setup-sdk.stories.tsx` | [x] `upload-artifacts.png` |
| T3 | `### Step 6: your coding agent wires the test data` | The pre-handoff countdown over the dimmed dashboard | full terminal | gallery scene `countdown` | [x] `tui-handoff.png` |

### `index.mdx` (landing)

| # | Heading | Shot | Framing | Story | Status |
|---|---|---|---|---|---|
| L1 | `## How it works`, after the 1-5 list (keep `test-lifecycle.jpg`) | PR review page: verdict headline + top findings. First sight of the actual product | zoomed crop, the proven `1600x470` framing | `pages-authoritativeprpage--report` (exists) | [x] `pr-review.png` |

No screenshot on the "What you set up" cards - three cards pointing at three different surfaces would need three shots to be fair, which is spam. L1 carries the page.

### `preview-environments/`

Mostly blocked on D1-D5. Ordered by value once unblocked.

| # | Page / heading | Shot | Framing | Story | Status |
|---|---|---|---|---|---|
| P1 | `secrets.md` `## Two ways to set a secret` | `EnvVarManager`: Connections/Secrets list plus the drawer showing a stored secret as `•••••• (set)` with **Replace value** | component | none - pure props, no network | [x] `variables-secret.png` |
| P2 | `secrets.md` `## Secret, connection, or config value?` (keep `what-goes-where.jpg`) | The drawer's Secret \| Connection control with its one-line rationale, one crop per segment | tight crop ~420x130 | none - same fixture as P1 | [x] `variables-secret.png (same shot)` |
| P3 | `connections.md` `## Wiring an app to a database` | Drawer in connection mode: `{{db.url}}` with the live "Fills in at deploy" resolution, plus the invalid-token state | zoomed crop | none - same fixture as P1 | [x] `variables-connection.png` |
| P4 | `databases.md` `## Where a task runs` | A setup-task row + the colour-coded In-the-build / Separate-job explainer, with the nested Phase sub-control | zoomed crop | none - `DatabaseSection`, pure props | [x] `setup-task-where.png` |
| P5 | `apps.md` `### Manual builds` | `BuildModeSection` manual: runtime grid + the live **Build spec** rail | component | `onboarding-buildmethod--converted-to-manual` (exists) | [x] `build-manual.png` |
| P6 | `apps.md` `## Build method` | Just the Manual \| Dockerfile toggle + active hint, one crop per segment | tight crop ~380x110 | crop from P5's story | [x] `build-manual.png (same shot)` |
| P7 | `hooks.md` `## Pre-deploy and post-deploy` - **blocked on D2** | `HooksSection` with one hook per group, showing the per-hook App picker | component | none - pure props | [ ] |
| P8 | `multirepo.md` `## Connected repositories` | `AddAppDialog` with a repo picked, revealing Alias + Fallback branch | full dialog | none - needs `github.listRepositories` | [ ] |
| P9 | `index.md` `## What you configure` - **blocked on D1** | Same MCP-first screen as M1 - reuse the asset | full page | `onboarding-mcpfirstconfig--waiting` | [ ] |
| P10 | `multirepo.md` `## Which branch gets deployed` | `BranchMatchingField` on Regex rewrite, so Pattern + Replacement are visible | component | none - pure props, trivial | [x] `branch-matching.png` |
| P11 | `services.md` `## Configuring an extra service` | A filled `ServiceCard`: fields, env-var rows, count chip, paste-`.env`, collapsed Advanced | component | none - pure props | [x] `service-card.png` |
| P12 | `services.md` `### Advanced service config` | Expanded Advanced with Readiness probe = HTTP, so the conditional fields show | zoomed crop | none - same fixture as P11 | [x] `service-probe.png` |
| P13 | `index.md` `## What you configure` | The config stepper: solid required cells vs dashed optional group | crop ~full width x 180 | none | [ ] |
| P14 | `hooks.md` `## Optional by design` | The `VariablesFinishFork` card: "most people finish here" + the two optional escapes | component | none - three callbacks + `disabled` | [ ] |

### `environment-factory/`

Deliberately thin. This section is mostly backend code the reader writes in their own repo; code blocks are the right tier and screenshots would be noise.

| # | Page / heading | Shot | Framing | Story | Status |
|---|---|---|---|---|---|
| E1 | `setup.mdx` `## 8. Go live` | Dry-run step **after a run**: per-scenario pass/fail rows with the inline failure reason | zoomed crop | `pages-finishsetupsdk--dry-run-step` shows the step **unrun** - needs a new export driving the run via `play` | [ ] |
| E2 | `setup.mdx` `## 7. Validate` | The validation row alone: target select, **Validate SDK**, `✓ Discovered 12 models` | tight crop | none - existing fixtures never render the chip | [x] `sdk-validated.png` |
| E3 | `security.md` `## Other common problems` | One `DryRunOutcomeNote` failure card with a real FK-violation message, and the **Fix with coding agent** button under it | component | `components-dryrunoutcomenote--failed-during-up` (exists) | [x] `dry-run-failed.png` |
| E4 | `setup.mdx` `## 8. Go live` | Scenarios → **Webhook calls** tab: DISCOVER/UP/DOWN badges, status codes, durations | zoomed crop, 5-6 rows | none - route is HARD (7+ fixtures) | [ ] |
| E5 | `index.mdx` `## Get started` | The planner's pre-handoff countdown - same asset as T3, reuse | full terminal | gallery scene `countdown` | [ ] |

There is **no dashboard screen that lists discovered models or their fields** - only the count. Do not imply a schema browser in an E2 caption.

## Where a screenshot would be wrong

Recorded so we do not relitigate:

- **MCP client config snippets** (`mcp/index.mdx`, `configure-preview.mdx`) - six tabbed code blocks, one per client. A shot of one client's settings UI dates instantly and covers one of six.
- **Tool tables** - a table is the right form for a tool inventory. Screenshotting an agent's chat transcript shows someone else's client, not Autonoma.
- **`configure-preview-flow.jpg`, `secrets-flow.jpg`, `what-goes-where.jpg`, `connections-resolution.jpg`, `ref-graph.jpg`, `lifecycle.jpg`, `multirepo-tree.jpg`** - all keep their diagrams. Screenshots supplement; they never replace. A diagram can show a retry edge, a trust boundary, a topological sort; a screenshot cannot.
- **The PR comment itself** - rendered by GitHub, not `apps/ui`. Outside the Storybook pipeline, and a real one embeds a customer repo name.
- **`environment-factory/factories.md` almost entirely** - factories are code the reader writes. Nothing in our product renders one.
- **The recipe JSON viewer** - it exists, but behind `isAdmin` and labelled "Admin Recipe Debug". Screenshotting it advertises a screen no customer can open.
- **Secrets themselves** - never in frame. The Finish setup step deliberately hides the shared secret.
- **`databases.md` "Which repository it runs against"** - documents settings recorded but not yet honored. A screenshot would make a no-op look functional.
- **`examples/index.md`** - a link table. The artifact the reader wants is a GitHub repo.
- **Any full-page `/app/$appSlug/preview-config`** - agent banner + rail + pane reads as noise at docs width. Crop to the pane, or use the onboarding-step equivalent.

## Volume

Roughly 25 images across the whole docs site, over half of them zoomed crops or component-only renders, and about a third needing no new story code. That is the ceiling, not a target - each one still has to earn its slot against the question the reader actually has at that point.


## Round 2 notes (the "do it for all" pass)

**A fixture leaked credential-shaped strings.** The Upload-test-artifacts shot renders the real command, and the story fixture used a realistic `ask_…64-hex` API token plus a hex shared secret. Publishing that in the docs teaches readers that pasting tokens into screenshots is normal. The fixture now uses `ask_your_api_token_here` / `your_shared_secret_here`. **Check any shot that renders a command or a config value for credential-shaped fixtures before shipping it.**

**The CLI question is settled: images, via a new renderer.** `apps/cli/scripts/render-tui-frames.tsx` renders a fixture scene headlessly to an ANSI frame, translates the SGR escapes into styled spans, and writes a standalone HTML page; Playwright then shoots it. Run `pnpm --filter @autonoma-ai/planner tui:frames <out-dir> [scene...]`. That makes terminal images reproducible - no hand-taken photo of somebody's terminal, no baked-in font or theme - and the TUI palette (`#CCFF00` on `#050505`) sits on the docs pages with no visible seam. A plain-text code block was the cheaper option but loses the layout and colour that are the entire point of the dashboard.

**Still open**

| # | What | Why not done |
|---|---|---|
| D2 / P7 | `hooks.md` contradicts the product's own copy on which hook does migrations vs seed data, and omits that every hook is bound to an app | Needs a product decision, not a docs edit. The story (`onboarding-previewconfigsections--lifecycle-hooks`) is written and ready to shoot the moment it is settled |
| M2 | The manual preview-config wizard | Needs a new page story at `?configStep=apps` |
| P8 | `AddAppDialog` with Alias + Fallback branch | Needs `github.listRepositories` fixtures |
| P9, P13, P14 | Config stepper, finish-fork card, add-app dialog on `preview-environments/index.md` | The overview now points at the agent path in prose; revisit whether it also needs its own images |
| E1 | Dry run **after** a run, with per-scenario results | Results live in component state behind a mutation, so it needs a `play` function. Feasible - `finish-setup-sdk.stories.tsx` now has a working `play` to copy - but a mixed pass/fail row set needs the tRPC handler to vary by input |
| E4 | Scenarios → Webhook calls tab | Route needs 7+ fixtures |
