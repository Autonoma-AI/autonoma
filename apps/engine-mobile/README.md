# @autonoma/engine-mobile

Appium-based mobile test execution engine for the Autonoma testing platform. Runs AI-driven end-to-end tests on real iOS and Android devices/emulators using natural language instructions.

This app implements the platform-specific driver interfaces defined in `@autonoma/engine` (the shared execution agent package) by wrapping Appium/WebDriverIO calls. The core agent loop, command system, and AI primitives all come from shared packages - this app only provides the mobile-specific glue.

## Tech Stack

- **Runtime:** Node.js (ESM-only)
- **Automation:** WebDriverIO + Appium (iOS and Android)
- **AI:** Gemini models via `@autonoma/ai` for element detection, assertions, and agent decision-making
- **Video:** Platform-native recording (iOS via Appium, Android via adb screenrecord)
- **Live Streaming:** MJPEG stream from Appium for real-time frame capture
- **Database:** Prisma via `@autonoma/db`
- **Storage:** S3 via `@autonoma/storage` (app packages, photos, artifacts)
- **Logging:** Sentry via `@autonoma/logger`

## Directory Structure

```
src/
  platform/              # Appium driver implementations and device setup
    drivers/             # ScreenDriver, TouchDriver, KeyboardDriver, ApplicationDriver
    mobile-installer.ts  # Connects to emulator, installs app, builds MobileContext
    env.ts               # Environment variable definitions
    android-video-recorder.ts
    ios-video-recorder.ts
    appium-image-stream.ts
    camera-injector.ts   # Injects photos into device camera (iOS/Android)
  execution-agent/       # Agent wiring
    mobile-agent/        # Factory that assembles the execution agent with mobile commands
    generation-api/      # Production entry point - runs a generation job by ID
    local-dev/           # Local development entry point - runs from markdown test files
test-prompts/            # Sample markdown test cases for local development
```

## Running

### Prerequisites

- A running Appium server (local or remote)
- An iOS simulator or Android emulator (or physical device)
- Environment variables configured (see below)

### Local Development

Run a test from a markdown file:

```bash
pnpm dev <path-to-test-prompt>
```

Test prompts use markdown with YAML frontmatter:

```markdown
---
packageUrl: s3://autonoma-assets/tmp-applications/my-app.apk
platform: ANDROID
photo: /path/to/default-camera-image.png
---

Open the app. Navigate to settings. Assert the profile section is visible.
```

### Production (Generation Job)

```bash
pnpm run-generation <testGenerationId>
```

## Environment Variables

Defined in `src/platform/env.ts` using `@t3-oss/env-core`. Extends environment configs from `@autonoma/logger`, `@autonoma/db`, `@autonoma/ai`, and `@autonoma/storage`.

| Variable | Required | Description |
|----------|----------|-------------|
| `APPIUM_HOST` | No | Appium server hostname |
| `APPIUM_PORT` | No | Appium server port |
| `APPIUM_MJPEG_PORT` | No | MJPEG streaming port for live frames |
| `APPIUM_SKIP_INSTALLATION` | No | Skip app installation on device (default: `true`) |
| `APPIUM_SYSTEM_PORT` | No | System port for Appium |
| `DEVICE_NAME` | No | Target device/emulator name |
| `IOS_PLATFORM_VERSION` | No | iOS version for capabilities |
| `ANDROID_DAEMON_HOSTS` | No | Comma-separated list of Android daemon host addresses |
| `IOS_DAEMON_HOSTS` | No | Comma-separated list of iOS daemon host addresses |
| `SKIP_DEVICE_DATE_UPDATE` | No | Skip updating device date/time (default: `false`) |

## Architecture Notes

### Driver Implementations

| Interface | Implementation | Description |
|-----------|---------------|-------------|
| `ScreenDriver` | `AppiumScreenDriver` | Screenshots via Appium, resolution from MJPEG stream |
| `MouseDriver` | `AppiumTouchDriver` | Touch actions (tap, scroll) via WebDriverIO |
| `KeyboardDriver` | `AndroidKeyboardDriver` / `IosKeyboardDriver` | Platform-specific keyboard input |
| `ApplicationDriver` | `AppiumApplicationDriver` | App stability detection |

### MobileInstaller

The `MobileInstaller` class handles the full device setup lifecycle:

1. Acquires an emulator via `@autonoma/emulator` (with distributed locking)
2. Waits for Appium to be ready
3. Downloads the app package from S3
4. Connects to Appium with retry logic (up to 5 attempts)
5. Installs and prepares the app on the device
6. Optionally injects a camera image
7. Builds the `MobileContext` with all driver instances

Cleanup releases the Appium session and emulator lock.

### Agent Commands

The mobile agent supports these commands (via `@autonoma/engine`):

- **click** - AI-powered tap on elements described in natural language
- **drag** - AI-powered drag between two points
- **type** - Find element + type text
- **scroll** - Scroll with optional visual condition targeting
- **assert** - Visual assertion checking with automatic assertion splitting
