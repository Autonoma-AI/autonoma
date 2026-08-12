---
name: ui-screenshots
description: "Read this skill whenever a PR changes UI (apps/ui or packages/blacklight) and you want to show how it looks on the PR: write a Storybook story with typed MSW fixtures, screenshot it headlessly, upload to S3, and embed the image in the PR description. Also covers the root README's committed product screenshots and when to re-shoot them. No backend, database, or onboarding needed."
---

# UI screenshots on PRs

Every PR that visibly changes the UI should carry screenshots in its description so reviewers see the result without checking out the branch. The pipeline: Storybook story (mock data) -> headless screenshot -> S3 presigned URL -> PR description.

## How rendering works

Storybook runs the real app code inside `apps/ui` with the real Vite config. Data is mocked at the network boundary with MSW - tRPC (`/v1/trpc/*`) and better-auth (`/v1/auth/*`) requests are answered from fixture objects **typed against `RouterOutputs`**, so mock data is compiler-checked against the real API and rots loudly when router outputs change.

Support code lives in `apps/ui/src/lib/storybook/`:

- `trpc-handler.ts` - `trpcHandler(fixtures)`: one MSW handler answering every tRPC call from a fixture tree (`{ router: { procedure: output } }`). Unmocked procedures return an error AND log `[storybook-fixtures]` to the console, which fails the screenshot script.
- `auth-handlers.ts` + `auth-fixtures.ts` - better-auth session/organization mocks (`makeSession()`, `makeOrganization()`).
- `base-fixtures.ts` - `appShellHandlers(pageFixtures)`: baseline satisfying the app-shell guards (session, approved org, one app: `baseApplication`, slug `acme-web`, github + billing). Pass page-specific tRPC fixtures and they deep-merge over the baseline.
- `story-shell.tsx` - global decorator for **component stories**: theme, toasts, fresh QueryClient, memory-router context (Link/useNavigate work). Applied automatically.
- `page-story.tsx` - `PageStory` for **page stories**: renders a real route through the real route tree (loaders, guards, layouts) at a given path.

## Writing a story

Stories go in `apps/ui/src/stories/*.stories.tsx` (or co-located with the component - but NEVER under `src/routes/`, the router plugin scans that tree). See `src/stories/app-home.stories.tsx` for the flagship example of both patterns.

Component story (props in, no network):

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MyPanel } from "components/my-feature/my-panel";

const meta = { title: "Components/MyPanel", component: MyPanel } satisfies Meta<typeof MyPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { args: { /* realistic props */ } };
```

Page story (full route, MSW-mocked):

```tsx
const meta = {
    title: "Pages/MyPage",
    component: PageStory,
    parameters: {
        pageStory: true, // skips the StoryShell decorator - the real route tree brings its own layouts
        msw: { handlers: appShellHandlers({ bugs: { listSummary: [/* ... */] } }) },
    },
} satisfies Meta<typeof PageStory>;
export const Default: Story = { args: { path: "/app/acme-web/bugs" } };
```

Writing fixtures: put a literal where the type demands it and let `pnpm --filter @autonoma/ui exec tsc --noEmit` guide you - the error messages spell out the exact output shape. Use realistic values (names, dates, counts a customer would have), never "test"/"foo". Committed fixtures double as a growing catalog of renderable app states - extend existing ones before writing new ones.

## Shooting

Boot the server, wait for it, shoot, and kill it - as **one** command:

```bash
cd apps/ui
PORT=6041   # any free port; see below on why not 6006
VITE_API_URL=https://api.autonoma.app ./node_modules/.bin/storybook dev -p "$PORT" --no-open --quiet &
SB=$!; trap 'kill $SB 2>/dev/null' EXIT
until curl -sf "localhost:$PORT/index.json" >/dev/null; do sleep 1; done
pnpm --filter @autonoma/ui storybook:shoot --story pages-mypage--default --url "http://localhost:$PORT"
```

- **Run that whole block in a single invocation.** A `trap ... EXIT` only fires in the shell that set it, and each agent tool call is a separate shell - launch in one call and shoot in the next and the trap is simply gone, leaving a Storybook dev server alive at ~60% CPU until a human notices. Nine of them once accumulated in one worktree over two days. If you must split the steps, kill by port when you are finished: `lsof -ti tcp:$PORT | xargs kill`. Either way, end with `pgrep -fl storybook` and confirm nothing of yours is left.
- **Keep the `until curl` line.** Storybook takes ~15s to boot. Shoot before it is listening and Playwright dies with `page.goto: Timeout 30000ms exceeded`, which reads like a broken script and invites a retry - i.e. a second orphaned server.
- **Use an explicit port, never the default 6006.** The `storybook` package script hardcodes 6006, and with ~100 worktrees on this machine another one is usually already there - you would silently screenshot a different branch's UI. Everything you point at the server, `index.json` included, must use the port you launched.
- `VITE_API_URL` does not affect the MSW mocking, which matches any origin - it changes only the API URL a screen *prints*. `env.VITE_API_URL` defaults to `http://localhost:4000` and `getApiOrigin()` returns it verbatim on localhost, so the MCP dialog, the planner command block, the onboarding setup steps and the deployment-signal endpoint all render a dev URL into the image unless you set it. Harmless on other screens, so it stays in the block rather than being a thing to remember per story.
- Story id = lowercased title with `/` -> `-`, then `--`, then the **kebab-cased** export name: `Pages/MyPage` + `Default` -> `pages-mypage--default`, and `WithOptimizedToggle` -> `--with-optimized-toggle` (NOT `--withoptimizedtoggle`). A wrong id silently screenshots Storybook's "Couldn't find story" error page, so for any multi-word export confirm the id against `curl -s "localhost:$PORT/index.json"`.
- Flags: `--story` (repeatable), `--out` (default `screenshots/`, gitignored), `--viewport 1440x900`, `--full-page`, `--settle-ms 500`, `--wait-until networkidle`, `--allow-unmocked`. Pass them straight after the script name - **no `--` separator**, which pnpm 11 forwards as a positional and the script rejects with `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`.
- The script EXITS 1 listing any tRPC procedure that had no fixture - add the missing fixtures rather than passing `--allow-unmocked`.
- ALWAYS Read the PNG yourself before uploading. Never post a screenshot showing an error state, empty shell, or "Something went wrong".

### Shooting a loading state

The default `--wait-until networkidle` waits for the network to go quiet, so it can only ever photograph a **settled** screen. A story that holds a query open to show its skeleton never reaches idle, and the run dies on `page.goto: Timeout 30000ms exceeded`. Wait for the document instead, and pick the moment with `--settle-ms`:

```bash
pnpm --filter @autonoma/ui storybook:shoot --wait-until domcontentloaded --settle-ms 4000 \
  --story waiting-screens--home --url "http://localhost:$PORT"
```

`apps/ui/src/stories/waiting-screens.stories.tsx` is the worked example: each export leaves one tRPC procedure unanswered, so the screen holds still in its waiting state. A **stalled procedure needs no fixture** - it never resolves, so the fixture-error exit does not fire.

Three things that make a skeleton screenshot lie:

- The script injects `DISABLE_MOTION_CSS` and sets `reducedMotion: "reduce"`, which kills `animate-pulse` - so a skeleton must read correctly as a flat shape, not rely on the pulse.
- A skeleton drawn in the same colour as the panel behind it is invisible in the PNG even though it is present in the DOM; check the computed background if a panel looks empty.
- **The first story shot against a freshly started Storybook can come back blank**, because Vite is still compiling the route tree on that first request and `--settle-ms` elapses before anything paints. It looks exactly like the regression you are testing for. Shoot a throwaway story first, or re-shoot the suspicious one once the server is warm, before believing a black frame.

## Publishing to the PR

Upload and presign (bucket is us-east-1; always pass `--region us-east-1`, a stray `AWS_REGION` breaks presigns):

```bash
aws s3 cp screenshots/pages-mypage--default.png \
  "s3://autonoma-assets/pr-ui-previews/pr-<PR_NUMBER>/pages-mypage--default.png" --region us-east-1
aws s3 presign "s3://autonoma-assets/pr-ui-previews/pr-<PR_NUMBER>/pages-mypage--default.png" \
  --expires-in 604800 --region us-east-1
```

**`--expires-in 604800` is a ceiling, not a promise: the URL dies with the role session that signed it - about an hour here.** SSO presigns carry an `ASIA...` key id and an `X-Amz-Security-Token`, and once that session lapses the object answers `400 ExpiredToken`. The trap is that this is invisible locally: the CLI silently refreshes the session, so `aws sts get-caller-identity` and fresh uploads keep working long after every URL you already handed out went dead. Only long-lived IAM user keys get the full 7 days.

**GitHub's image proxy is what makes this survivable, but only if it fetches while the URL is still valid.** Rendering rewrites each image to `camo.githubusercontent.com/<hash>/<hex-encoded-url>`, and camo caches a successful fetch for a year (`cache-control: public, max-age=31536000`). Nobody has to open the PR in that first hour - **you** warm it, immediately after editing the body:

```bash
gh api repos/<org>/<repo>/pulls/<PR_NUMBER> -H "Accept: application/vnd.github.html+json" --jq '.body_html' \
  | grep -o '<img src="https://camo[^"]*"' | sed 's/<img src="//; s/"$//' \
  | while read -r u; do curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$u"; done
```

Every line must be `200 image/png`; re-fetch one with `-D -` and look for `x-cache: HIT` to confirm the bytes are cached. **Skip this and the screenshots die within the hour** - camo's first fetch then lands on the expired URL, returns `502 Error Fetching Resource`, and the PR shows a broken-image glyph with the alt text as a link. Note that `curl`ing the S3 URL yourself proves nothing about that: it is camo, not the reviewer's browser, that has to reach S3.

Recovering from a cold 502: re-presign (the objects are still there - a lifecycle rule on `pr-ui-previews/` deletes them after 30 days - so no re-shoot, no re-upload), replace the marker section, then warm. A new signature means a new camo hash, so the cached failure is not in the way. The bucket is private, so there is no unsigned fallback: a plain `https://autonoma-assets.s3...` URL is a 403. If an image has to render forever, commit it instead, the way the root README does.

Then edit the PR **description** (not a comment), maintaining an idempotent section - replace it wholesale if it already exists:

```markdown
<!-- ui-screenshots:start -->
## UI screenshots

![Pages/MyPage - Default](<presigned-url>)
<!-- ui-screenshots:end -->
```

Wrap the presigned URL in `<angle brackets>` - it contains `&` characters that break bare markdown links. Update with `gh pr edit <PR_NUMBER> --body-file <file>`.

On re-runs (new commits changed the UI again): re-shoot, re-upload to the same keys, re-presign (URLs change), replace the marker section in the description, and warm camo again - a new URL is a new camo hash, so the old cached bytes do not carry over.

## The root README's screenshots

The root `README.md` is the public mirror's front page and embeds two product screenshots shot from this same pipeline. They are the one exception to everything above: **committed to the repo, never uploaded to S3**, because a presigned URL expires in 7 days and the README has to keep rendering forever.

| Asset | Story | Viewport |
|---|---|---|
| `.github/assets/pr-review.webp` | `pages-authoritativeprpage--report` | `1600x470` |
| `.github/assets/analysis-issue.webp` | `pages-authoritativesnapshotpage--issue` | `1600x1290`, sidebar cropped |

**When you change the PR review page or the analysis issue page, re-shoot the one you affected and commit it in the same PR.** A stale screenshot on the front page is worse than none - it advertises a UI we no longer ship.

```bash
pnpm --filter @autonoma/ui storybook:shoot --url "http://localhost:$PORT" \
  --story pages-authoritativeprpage--report --viewport 1600x470 --out screenshots/readme
cwebp -q 88 apps/ui/screenshots/readme/pages-authoritativeprpage--report.png \
  -o .github/assets/pr-review.webp
# analysis-issue additionally crops off the app sidebar: -crop 199 0 1401 1290
```

Rules for anything under `.github/assets/`:

- **WebP only.** `*.png` / `*.jpg` are LFS-tracked repo-wide, and README art must not be: `sync-public.yml` clones the mirror with `GIT_LFS_SKIP_SMUDGE=1`, so an LFS-backed image lands on the public repo as pointer text, and anonymous README views bill against the LFS bandwidth quota. `.gitattributes` unsets the filters for that directory as a backstop.
- **Pick the viewport so the shot ends on a section boundary.** These are viewport screenshots, not `--full-page`, so the height is the crop. Nudge it until nothing is cut mid-paragraph or mid-code-block rather than cropping afterwards.
- **Look at the result before committing**, same as any other screenshot here.

The banner (`.github/assets/banner.webp`) is generated art, not a screenshot - see the `documentation-authoring` skill for the image generator, and keep it on the docs palette (`#0a0a0a` background, `#C2E812` accent).

## Screenshots for the docs site

`apps/docs` uses screenshots as a third image tier alongside the generated hero and diagram art. The plan, the per-page opportunity list, and what is already shipped live in `apps/docs/screenshot-plan.md` - read it before adding one.

Two things bite here that do not bite on a PR screenshot:

- **Start Storybook with `VITE_API_URL=https://api.autonoma.app`.** Storybook serves from localhost, and `getApiOrigin()` (`apps/ui/src/lib/api-origin.ts`) returns `env.VITE_API_URL` on localhost - so any screen rendering an endpoint bakes `http://localhost:4000` into the image. The MCP config screen shows a full `claude mcp add` command; shipped unset, it teaches readers the wrong URL. Scan the frame for dev hostnames before shipping.
- **A full-page shot is unreadable at docs width.** The content column is ~768px, so a 1440-wide capture lands at a 53% downscale. Crop the nav rail and top bar off - the same shot at 1120 wide reads at ~72%, which is the difference between legible and not. And never place an image inside a numbered list item; it inherits the list indent and shrinks further.

**Padding belongs in the story, not the crop.** Give each story's decorator a generous `p-14` and a `bg-surface-void`, shoot at the decorator's own max-width, and crop **only the dead space below the component**. Never trim the left, right or top edge - `sharp.trim()` removes uniform borders, which means it eats exactly the padding the decorator just added, and then the content sits flush against the image border no matter how much you extend afterwards. This cost three rounds to spot.

**Page stories have no decorator to hang padding on**, since they render the real app shell. There the crop carries the margin: pick the content rectangle by eye from a full capture, subtract the margin from `left`/`top` and add twice it to `width`/`height`. Where the page's own whitespace is thinner than the margin you want, `extend` the canvas with the page background sampled from an empty region of the same shot - that is safe here precisely because there is no decorator padding for a trim to eat.

One trap when you add that padding: it comes out of the content width, so `max-w-4xl` minus `p-14` leaves 784px and drops the component below the `lg` breakpoint - which silently collapsed the Build spec rail into one column. Widen the decorator (`max-w-5xl`) so the padding does not change which layout renders, and check the shot still shows the same layout a user sees.

**The old approach, kept only as background:** `.docs-content img` renders at 100% of the ~768px content column and draws a 1px border, so content flush to the edge reads as cropped rather than framed - and sits oddly next to the generated diagrams, which have their own internal margin. Pad to `--surface-base` (`#0a0a0a`), the colour the image slot already sits on, so the padding is invisible and only the breathing room shows.

Scale the pad to the *rendered* size, not the pixel size: a 2x terminal capture is ~2150px wide and a component crop ~880px, but both render at ~768px, so a flat pixel pad lands at wildly different sizes on the page. Target ~30px rendered - `pad = round(30 * max(1, width / 768))`. Trim the image first so the step is idempotent and captures from different paths end up equal.

Docs images go to `apps/docs/public/img/<section>/<name>.png` (PNG, not JPEG - chroma subsampling smears thin UI text on dark backgrounds) and are referenced as `/img/<section>/<name>.png`. Verify with `cd apps/docs && node_modules/.bin/astro build`, then `astro preview` and look at the page at ~1280px wide.

**Alt text is the whole value of the image to an agent.** `llms.txt` / `llms-full.txt` are generated at build time and an image degrades to its alt text there, so describe what is actually on screen - the labels, the states, the numbers - not "screenshot of the config page".
