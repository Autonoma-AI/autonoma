# @autonoma/engine

The core platform-agnostic engine for agentic test execution. This package contains the AI agent loop, command system, driver interfaces, and runner infrastructure that both `engine-web` (Playwright) and `engine-mobile` (Appium) extend.

Everything is parameterized with `TSpec` (command spec) and `TContext` (driver context), so the same agent core works for both web and mobile.

## Package Exports

| Export Path | Description |
|-------------|-------------|
| `@autonoma/engine` | Full API - agent, commands, drivers, runner |
| `@autonoma/engine/command-defs` | Lightweight types only - command specs, no runtime dependencies |

## How the Agent Works

The `ExecutionAgent` wraps the Vercel AI SDK's `ToolLoopAgent`. Each iteration:

1. **Screenshot** - captures current screen state
2. **Inject context** - packages screenshot + instruction + steps-so-far into a user message
3. **LLM decides** - model picks which tool/command to call (or finishes)
4. **Command executes** - the chosen command runs against platform drivers
5. **Record step** - saves the step with before/after metadata
6. **Loop or stop** - continues until `execution-finished` is called or `maxSteps` (default 50) is reached

## Built-in Commands

| Command | Exposed to LLM | What it does |
|---------|----------------|--------------|
| **click** | Yes | Takes a natural-language element description, uses `PointDetector` AI to locate pixel coordinates, calls `mouse.click(x, y)` |
| **type** | Yes | Uses `PointDetector` to find element, clicks it, then types text |
| **scroll** | Yes | Scrolls up/down, optionally targeting a visual condition |
| **assert** | Yes | Decomposes compound assertions, takes screenshot, checks all in parallel |
| **drag** | Yes | AI-powered drag between two points |
| **hover** | Yes | Moves cursor over an element |
| **read** | Yes | Extracts text from a UI element using `TextExtractor` |
| **refresh** | Yes | Reloads the page |
| **navigate** | Yes | Navigates to a URL via `NavigationDriver` |
| **save-clipboard** | Yes | Saves clipboard contents |

## LLM Tools (non-command)

| Tool | Purpose |
|------|---------|
| **wait** | Sleeps for N seconds. Not recorded as a step |
| **ask-user** | Sends questions to a human via WebSocket. Pauses until answered |
| **execution-finished** | Called by the model to end the test. Takes `{ success, reasoning }` |

## Driver Interfaces

Platform-specific apps implement these interfaces:

- **`ScreenDriver`** - `screenshot()`, `getResolution()`
- **`MouseDriver`** - `click(x, y)`, `scroll(direction)`
- **`KeyboardDriver`** - `type(text)`, `press(key)`
- **`ApplicationDriver`** - `waitUntilStable()`
- **`NavigationDriver`** - `navigate(url)`, `getCurrentUrl()`

`BaseCommandContext` also carries an optional **`dialogs?: DialogObserver`**. Platforms with native browser dialogs (web) wire this up to record auto-handled `alert`/`confirm`/`prompt`/`beforeunload` popups; the agent drains it once per step (`getStepContext`) and surfaces the dialogs as context, since native dialogs are browser chrome and never appear in a screenshot. Absent on platforms without native dialogs (mobile), in which case the agent skips dialog reporting. `DialogObserver`, `NativeDialogEvent`, and `NativeDialogType` are exported from `@autonoma/engine`.

## CommandSpec - The Command Type System

Every command is defined by a `CommandSpec`:

```ts
interface CommandSpec {
  interaction: string      // command name (e.g., "click")
  params: object           // resolved parameters recorded with the step
  output: { outcome: string } // what the command returns
}
```

`Command<TSpec, TContext>` is the abstract base class all commands extend. Key members:
- `interaction` - command name (becomes the LLM tool name)
- `paramsSchema` - Zod schema for `params`
- `execute(params, context)` - performs the action

What the LLM sees lives on the matching `CommandTool` (`execution-agent/agent/tools/commands/<name>.tool.ts`), which supplies `description()`, `inputSchema()`, and an `extractParams()` that turns the model's natural-language input into `params`.

## Runner & Artifacts

`ExecutionAgentRunner` orchestrates a full test run:
1. Calls `Installer.install()` to build platform context
2. Registers frame handler for live streaming
3. Wraps `agent.generate()` in `VideoRecorder.withRecording()`
4. Returns `{ result, videoPath }`

`LocalRunner` extends this for local development - loads test cases from markdown files and saves artifacts to disk.

## Extending for a New Platform

1. Implement all driver interfaces using your platform's SDK.
2. Create an `Installer` subclass that builds the context (drivers + image stream + video recorder).
3. Create an `ExecutionAgentFactory` subclass for platform-specific setup.
4. Create a runner entry point that wires everything together.

## Adding a New Command

Each command is a triplet of files. Mirror an existing one (e.g. `commands/commands/click/`):

1. **`<name>.def.ts`** - the `CommandSpec` interface (`interaction`, `params`, `output`) plus a base param Zod schema, re-exported from `commands/command-defs.ts`.
2. **`<name>.command.ts`** - a `Command<YourSpec, YourContext>` subclass implementing `interaction`, `paramsSchema`, and `execute(params, context)`. Add platform variants (`web-<name>.command.ts`, `mobile-<name>.command.ts`) when behavior differs. Export it from `commands/commands/index.ts`.
3. **`<name>.tool.ts`** (under `execution-agent/agent/tools/commands/`) - a `CommandTool` subclass implementing `description()`, `inputSchema()`, and `extractParams()`. Export it from that directory's `index.ts` and add it to the `commandTools` list the platform passes to its `ExecutionAgentFactory`.

The `execution-agent` skill also covers the required `CommandUI` entry in `@autonoma/blacklight` - without it, recorded steps silently render as "Unknown" in the app.

## Dependencies

- `@autonoma/ai` - model registry, visual AI, point/object detection
- `@autonoma/image` - screenshot manipulation, bounding boxes
- `@autonoma/logger` - structured logging
- `@autonoma/try` - Go-style error handling
- `ai` (Vercel AI SDK) - agent loop, tool definitions
- `zod` - schema validation
