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

```bash
pnpm --filter @autonoma/ui storybook          # dev server on :6006 - run in background, takes ~15s
pnpm --filter @autonoma/ui storybook:shoot -- --story pages-mypage--default
```

- Story id = lowercased title with `/` -> `-`, then `--`, then the **kebab-cased** export name: `Pages/MyPage` + `Default` -> `pages-mypage--default`, and `WithOptimizedToggle` -> `--with-optimized-toggle` (NOT `--withoptimizedtoggle`). A wrong id silently screenshots Storybook's "Couldn't find story" error page, so for any multi-word export confirm the id against `curl -s localhost:6006/index.json`.
- Flags: `--story` (repeatable), `--out` (default `screenshots/`, gitignored), `--viewport 1440x900`, `--full-page`, `--settle-ms 500`, `--allow-unmocked`.
- The script EXITS 1 listing any tRPC procedure that had no fixture - add the missing fixtures rather than passing `--allow-unmocked`.
- ALWAYS Read the PNG yourself before uploading. Never post a screenshot showing an error state, empty shell, or "Something went wrong".

## Publishing to the PR

Upload and presign (bucket is us-east-1; always pass `--region us-east-1`, a stray `AWS_REGION` breaks presigns):

```bash
aws s3 cp screenshots/pages-mypage--default.png \
  "s3://autonoma-assets/pr-ui-previews/pr-<PR_NUMBER>/pages-mypage--default.png" --region us-east-1
aws s3 presign "s3://autonoma-assets/pr-ui-previews/pr-<PR_NUMBER>/pages-mypage--default.png" \
  --expires-in 604800 --region us-east-1
```

Links live 7 days (presign max); the objects themselves are auto-deleted after 30 days by a lifecycle rule on the `pr-ui-previews/` prefix. Both are fine - screenshots matter at review time, and GitHub's image proxy caches them.

Then edit the PR **description** (not a comment), maintaining an idempotent section - replace it wholesale if it already exists:

```markdown
<!-- ui-screenshots:start -->
## UI screenshots

![Pages/MyPage - Default](<presigned-url>)
<!-- ui-screenshots:end -->
```

Wrap the presigned URL in `<angle brackets>` - it contains `&` characters that break bare markdown links. Update with `gh pr edit <PR_NUMBER> --body-file <file>`.

On re-runs (new commits changed the UI again): re-shoot, re-upload to the same keys, re-presign (URLs change), and replace the marker section in the description.

## The root README's screenshots

The root `README.md` is the public mirror's front page and embeds two product screenshots shot from this same pipeline. They are the one exception to everything above: **committed to the repo, never uploaded to S3**, because a presigned URL expires in 7 days and the README has to keep rendering forever.

| Asset | Story | Viewport |
|---|---|---|
| `.github/assets/pr-review.webp` | `pages-authoritativeprpage--report` | `1600x470` |
| `.github/assets/analysis-issue.webp` | `pages-authoritativesnapshotpage--issue` | `1600x1290`, sidebar cropped |

**When you change the PR review page or the analysis issue page, re-shoot the one you affected and commit it in the same PR.** A stale screenshot on the front page is worse than none - it advertises a UI we no longer ship.

```bash
pnpm --filter @autonoma/ui storybook:shoot -- \
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
