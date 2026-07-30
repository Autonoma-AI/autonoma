# @autonoma/engine-web

Playwright-based web test execution engine for the Autonoma testing platform. This app implements the platform-specific driver interfaces defined in `@autonoma/engine` (execution-agent) using Playwright, enabling AI-driven end-to-end web testing on Chromium browsers.

## Tech Stack

- **Runtime:** Node.js (ESM-only)
- **Browser Automation:** Playwright (Chromium)
- **AI:** Gemini models via `@autonoma/ai` for element detection, assertions, and agent reasoning
- **Database:** Prisma (PostgreSQL) via `@autonoma/db`
- **Storage:** S3 via `@autonoma/storage`
- **Logging:** Sentry via `@autonoma/logger`

## Directory Structure

```
src/
├── index.ts                          # Package re-exports
├── platform/                         # Playwright driver implementations
│   ├── drivers/
│   │   ├── playwright-screen.driver.ts
│   │   ├── playwright-mouse.driver.ts
│   │   ├── playwright-keyboard.driver.ts
│   │   ├── playwright-clipboard.driver.ts
│   │   ├── playwright-application.driver.ts
│   │   ├── playwright-navigation.driver.ts
│   │   └── connect-remote-browser.ts
│   ├── web-installer.ts
│   ├── web-context.ts
│   ├── native-dialog-handler.ts        # auto-accept + record native alert/confirm/prompt dialogs
│   ├── cursor-overlay.ts               # synthetic mouse pointer drawn into the page for the recording
│   ├── web-video-recorder.ts
│   ├── finalize-webm.ts                # remux Playwright WebM into a seekable file
│   ├── playwright-image-stream.ts
│   ├── active-page-manager.ts
│   ├── scenario-auth.ts
│   └── env.ts
├── execution-agent/                  # AI agent wiring
│   ├── web-agent/
│   │   ├── web-agent-factory.ts
│   │   └── web-agent-types.ts
│   ├── generation-api/
│   │   └── run-generation-job.ts
│   ├── local-dev/
│   │   ├── run-execution.ts
│   │   └── cost-summary.ts
│   └── env.ts
test-prompts/                         # Sample markdown test cases for local dev
```

## Running

### Local Development

Run a test case from a markdown file:

```bash
pnpm dev <path-to-test-prompt>
```

Example:

```bash
pnpm dev test-prompts/yc-graham-essays.md
```

This launches a local Chromium browser, executes the AI agent against the test prompt, and saves artifacts (screenshots, steps, video) to a local directory.

### Production Jobs

**Generation job** - executes an AI-driven test generation:

```bash
pnpm run-generation <testGenerationId>
```

In production, this runs as a Kubernetes Job with a remote browser sidecar.

### Other Commands

```bash
pnpm build        # Compile TypeScript
pnpm typecheck    # Type-check without emitting
pnpm lint         # Run Biome linter
pnpm test         # Run Vitest tests
```

## Environment Variables

Defined in `src/execution-agent/env.ts` and `src/platform/env.ts` using `@t3-oss/env-core`:

| Variable | Required | Description |
|----------|----------|-------------|
| `REMOTE_BROWSER_URL` | No | WebSocket endpoint for a remote Chromium instance (e.g., `127.0.0.1:3000`). If unset, launches a local browser. |
| `HEADLESS` | No | Set to `"true"` to run Chromium in headless mode. Defaults to headed. |
| `NATIVE_DIALOGS_ENABLED` | No | Auto-handle native dialogs (alert/confirm/prompt) during generation. Defaults to enabled; set to `"false"` to disable. |
| `CURSOR_OVERLAY_ENABLED` | No | Draw a synthetic mouse pointer into the page so the run recording shows where the agent acted. Defaults to enabled; set to `"false"` as a kill switch (it injects DOM into the application under test). |

Additionally, environment variables are inherited from shared packages (`@autonoma/logger`, `@autonoma/db`, `@autonoma/ai`, `@autonoma/storage`).

## Architecture Notes

- **Platform-agnostic core.** All AI agent logic, command abstractions, and the execution loop live in `@autonoma/engine`. This app only provides Playwright-specific driver implementations.
- **WebContext** bundles all Playwright drivers (screen, mouse, keyboard, clipboard, application, navigation) into a single object the agent commands operate on.
- **Remote browser support.** In production, the engine connects to a remote Chromium instance via WebSocket rather than launching a local browser.
- **Synthetic cursor.** Playwright dispatches mouse events straight into the renderer over CDP, so no recording or screenshot ever contains a real pointer. `cursor-overlay.ts` injects a cosmetic one (`context.addInitScript`, so it survives navigations and new tabs) that glides to each target and leaves a ring on every click. Three constraints shape it: it never moves the real pointer (gliding a live one would drag it across intervening elements and pop hover menus that swallow the click); nothing animates while it is at rest (the reviewer's video is resampled to 1 fps and `mpdecimate`-decimated, and constant motion would defeat that); and `ScreenDriver.screenshot` hides it, because the step screenshot the UI renders is captured *before* the agent picks its command, making a drawn pointer one action stale there - the UI draws its own marker from the step result instead. The init script is shipped as a **string**, not a function: Playwright serialises init scripts with `Function.prototype.toString`, and esbuild's keep-names rewrite (`__name(...)`) does not exist in the page, so a serialised function throws at document start and the overlay silently never mounts.
- **Video recording** uses Playwright's built-in video API, made seekable in two steps. (1) `WebVideoRecorder` reads the recording with `video.saveAs()`, never `video.path()`: the context-level recording is only flushed to disk when the browser context closes (during cleanup, after the upload), so `path()` returns a half-written, truncated file - the original cause of the unseekable, `duration=N/A` recordings. (2) `finalize-webm.ts` then remuxes the finalized file with ffmpeg (`-c copy`, no re-encode, via `@ffmpeg-installer/ffmpeg`) to add the Cues seek index. The upload is tagged `video/webm` so object storage does not serve it as `application/octet-stream`.
- **ActivePageManager** tracks which page is currently active, handling new tabs/popups transparently so drivers always operate on the correct page.
- **Native dialogs.** Playwright auto-DISMISSES native `alert`/`confirm`/`prompt`/`beforeunload` dialogs when no handler is registered, which silently cancels `confirm()`-gated flows (delete/save) and makes the agent flail clicking an "OK" button that is not in the DOM. `native-dialog-handler.ts` instead auto-ACCEPTS them (prompts submit their default value; `beforeunload` is accepted so intended navigation proceeds) and records each into a `DialogObserver` (from `@autonoma/engine`) exposed on `WebContext.dialogs`. The agent drains the observer once per step and surfaces the dialogs as context, so the model and the post-run classifier get ground truth about what the popup said. Decisions must be by policy: the action that opens a dialog blocks until it is resolved, so the outcome cannot be deferred to a later agent step. Enabled during **generation** (gated by the `WebInstaller` constructor + `NATIVE_DIALOGS_ENABLED`), and drained by the generation agent once per step.
- **Default viewport** is 1920x1080 across all entry points.
- **Agent tools** include: click, hover, drag, type, assert, scroll, refresh, read (text extraction), and save-clipboard.
