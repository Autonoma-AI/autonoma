---
title: Execution Agent
description: Deep dive into the core test execution engine - a platform-agnostic AI agent that powers web and mobile test execution through natural language.
---

The execution agent is the brain of Autonoma's test execution. It is a **generic, platform-agnostic AI agent** that takes a natural language test instruction, interacts with a live application through screenshots and commands, and produces a structured test result with recorded steps.

Web (`engine-web`) and mobile (`engine-mobile`) engines both extend this shared core. Everything is parameterized with `TSpec` (command spec) and `TContext` (driver context), so the same agent logic works across Playwright and Appium without code duplication.

## The Agent Loop

Every test execution follows the same cycle:

```
┌─────────────────────────────────────────────────────┐
│  1. Screenshot  - capture current screen state       │
│  2. Inject context - screenshot + instruction +      │
│     steps-so-far + memory into a user message        │
│  3. LLM decides - model picks a tool/command         │
│     (or calls execution-finished)                    │
│  4. Command executes - the chosen command runs       │
│     against platform drivers                         │
│  5. Record step - save before/after metadata,        │
│     execution output, and screenshots                │
│  6. Wait planning - asynchronously generate a wait   │
│     condition for replay                             │
│  7. Loop or stop - continue until execution-finished │
│     is called or maxSteps is reached                 │
└─────────────────────────────────────────────────────┘
```

The agent wraps the Vercel AI SDK's `ToolLoopAgent`. Before each step, it captures a screenshot and injects it alongside the test instruction, all previous steps, and any stored memory variables. The LLM then decides which command to call next.

**Loop detection:** If the model's reasoning mentions "loop", "stuck", "no progress", or "repeating" in a `success: false` finish, the result is flagged as a loop.

**Success validation:** Even if the model calls `execution-finished` with `success: true`, the agent verifies that at least one command step was executed and at least one `assert` step exists. If either check fails, the result is overridden to `success: false`.

## Directory Structure

```
packages/engine/src/
├── commands/                          # Command abstraction system
│   ├── command-spec.ts                # CommandSpec type definition
│   ├── command.ts                     # Abstract Command base class
│   ├── command-defs.ts                # Union of all command specs
│   ├── step.ts                        # StepData type
│   └── commands/                      # Built-in command implementations
│       ├── click/                     # AI-powered element clicking
│       ├── type/                      # Find element + type text
│       ├── scroll/                    # Scroll with condition checking
│       ├── assert/                    # Visual assertion checking
│       ├── hover/                     # Hover over elements (web only)
│       ├── drag/                      # Drag from one element to another
│       ├── read/                      # Extract text from screen into memory
│       ├── refresh/                   # Refresh the current page
│       ├── save-clipboard/            # Save clipboard content to memory
│       └── wait-until/                # Wait for visual condition (not LLM-exposed)
├── execution-agent/                   # Core AI agent loop
│   ├── agent/
│   │   ├── execution-agent.ts         # Main agent class
│   │   ├── execution-agent-factory.ts # Abstract factory for building agents
│   │   ├── execution-result.ts        # Result types
│   │   ├── test-case.ts               # TestCase interface
│   │   ├── system-prompt.ts           # Agent system prompt
│   │   ├── memory/                    # Variable memory store
│   │   ├── components/
│   │   │   └── wait-planner.ts        # Generates wait conditions between steps
│   │   └── tools/                     # LLM tools
│   │       ├── command-tool.ts        # Wraps Command as an AI SDK tool
│   │       ├── execution-finished-tool.ts
│   │       ├── ask-user-tool.ts
│   │       ├── wait-tool.ts
│   │       └── skill-resolver-tool.ts
│   ├── runner/
│   │   ├── execution-agent-runner.ts  # Main runner - ties installer + factory + recording
│   │   ├── artifacts.ts               # Writes screenshots, steps, video to disk
│   │   └── events.ts                  # Event hooks (beforeStep, afterStep, frame)
│   └── local-dev/
│       ├── local-runner.ts            # Local dev runner (loads markdown test files)
│       └── load-test-case.ts          # Parses markdown frontmatter into test cases
└── platform/                          # Platform driver interfaces
    ├── context/
    │   ├── base-context.ts            # BaseCommandContext (screen + application drivers)
    │   ├── installer.ts               # Abstract Installer
    │   ├── image-stream.ts            # Live frame streaming interface
    │   └── video-recorder.ts          # Abstract VideoRecorder with state machine
    └── drivers/
        ├── screen.driver.ts           # screenshot(), getResolution()
        ├── mouse.driver.ts            # click(), hover(), drag(), scroll()
        ├── keyboard.driver.ts         # type(), press(), selectAll(), clear()
        ├── application.driver.ts      # waitUntilStable()
        ├── navigation.driver.ts       # navigate(), getCurrentUrl(), refresh()
        └── clipboard.driver.ts        # read()
```

## CommandSpec - The Command Type System

Every command is defined by a `CommandSpec`:

```ts
interface CommandSpec {
  interaction: string;  // command name (e.g., "click")
  params: object;       // what gets stored for replay
  output: BaseOutput;   // what the command returns (always includes `outcome: string`)
}
```

The `Command<TSpec, TContext>` abstract base class is what all commands extend:

```ts
abstract class Command<TSpec extends CommandSpec, TContext extends BaseCommandContext> {
  abstract readonly interaction: TSpec["interaction"];
  abstract readonly paramsSchema: z.ZodSchema<CommandParams<TSpec>>;
  abstract execute(params: CommandParams<TSpec>, context: TContext): Promise<CommandOutput<TSpec>>;
}
```

The `CommandTool<TSpec, TContext>` class wraps a `Command` to make it compatible with the AI SDK. It adds:
- An `inputSchema()` that defines what the LLM provides (may differ from `paramsSchema`)
- A `description()` shown to the AI model
- An `extractParams()` method that converts LLM input into command parameters

This separation means the LLM can provide a natural language description ("the blue submit button") while the stored params contain the resolved coordinates and structured data needed for replay.

## Built-in Commands

| Command | Exposed to LLM | Params | What it does |
|---------|----------------|--------|--------------|
| **click** | Yes | `{ description, options }` | Takes a natural-language element description, uses `PointDetector` AI to locate pixel coordinates, calls `mouse.click(x, y)` |
| **type** | Yes | `{ description, text, overwrite }` | Uses `PointDetector` to find the input element, clicks it, then types the text. Supports overwrite mode to replace existing content |
| **assert** | Yes | `{ instruction }` | Takes an instruction (can contain multiple assertions). Uses `AssertionSplitter` to decompose, takes one screenshot, runs `AssertChecker` on all assertions in parallel |
| **scroll** | Yes | `{ elementDescription?, direction, condition, maxScrolls }` | Scrolls up or down on a specific element or the page, checking a visual condition after each scroll |
| **hover** | Yes | `{ description }` | Hovers over an element identified by natural language description (web only) |
| **drag** | Yes | `{ startDescription, endDescription }` | Drags from one element to another, both identified by natural language |
| **read** | Yes | `{ description, variableName }` | Extracts text from the screen and stores it in the agent's memory under `variableName` for use in later steps via `{{variableName}}` syntax |
| **refresh** | Yes | (none) | Refreshes the current page |
| **save-clipboard** | Yes | `{ variableName }` | Reads clipboard content and stores it in memory under `variableName` |
| **wait-until** | No | `{ condition, timeout }` | Polls a visual condition every second up to timeout using `VisualConditionChecker`. Auto-generated by `WaitPlanner`, not callable by the LLM |

## LLM Tools (Non-Command)

These tools are available to the model but are not recorded as test steps:

| Tool | Purpose |
|------|---------|
| **wait** | Sleeps for N seconds. Useful for loading screens or animations |
| **ask-user** | Sends questions to a human via WebSocket. Pauses execution until answered. Only available in frontend-connected sessions |
| **execution-finished** | Called by the model to end the test. Takes `{ success, reasoning }` |
| **resolve-skill** | Resolves a reusable sub-flow from a skills directory. Only available when skills config is provided |

## Driver Interfaces

Platform-specific apps (`engine-web`, `engine-mobile`) implement these interfaces:

### ScreenDriver

```ts
interface ScreenDriver {
  getResolution(): Promise<ScreenResolution>;
  screenshot(): Promise<Screenshot>;
}
```

### MouseDriver

```ts
interface MouseDriver<TClickOptions extends object = Record<string, never>> {
  click(x: number, y: number, options?: TClickOptions): Promise<void>;
  hover?(x: number, y: number): Promise<void>;
  drag(startX: number, startY: number, endX: number, endY: number): Promise<void>;
  scroll(args: ScrollArgs): Promise<void>;
}
```

### KeyboardDriver

```ts
interface KeyboardDriver {
  selectAll(): Promise<void>;
  clear(): Promise<void>;
  type(text: string, options?: TypeOptions): Promise<void>;
  press(key: string): Promise<void>;
}
```

### ApplicationDriver

```ts
interface ApplicationDriver {
  waitUntilStable(): Promise<void>;
}
```

### NavigationDriver

```ts
interface NavigationDriver {
  navigate(url: string): Promise<void>;
  getCurrentUrl(): Promise<string>;
  refresh(): Promise<void>;
}
```

### ClipboardDriver

```ts
interface ClipboardDriver {
  read(): Promise<string>;
}
```

The `BaseCommandContext` requires only `screen` and `application` drivers. Each platform extends this with additional drivers as needed.

## Memory System

The agent maintains a `MemoryStore` - a key-value store that persists across steps within a single execution. Commands like `read` and `save-clipboard` write values into memory, and any subsequent command can reference stored values using `{{variableName}}` template syntax.

When a command executes, the agent resolves `{{variableName}}` templates in the parameters before passing them to the command. The unresolved params are stored for replay (keeping the template references), while the resolved values are used for actual execution.

## Adding a New Command

1. **Define the spec.** Create a `CommandSpec` type for the command's interaction, params, and output:

```ts
// packages/engine/src/commands/commands/my-command/my-command.def.ts
import z from "zod";

export interface MyCommandSpec {
  interaction: "my-command";
  params: { target: string; value: number };
  output: { outcome: string; success: boolean };
}

export const myCommandParamsSchema = z.object({
  target: z.string().describe("Description for the LLM"),
  value: z.number().describe("A numeric value"),
});
```

2. **Implement the command.** Create a class extending `Command`:

```ts
// packages/engine/src/commands/commands/my-command/my-command.command.ts
import { Command } from "../../command";
import { type MyCommandSpec, myCommandParamsSchema } from "./my-command.def";

export class MyCommand extends Command<MyCommandSpec, YourContext> {
  readonly interaction = "my-command" as const;
  readonly paramsSchema = myCommandParamsSchema;

  async execute(params, context) {
    // Use context drivers to perform the action
    return { outcome: "Did the thing", success: true };
  }
}
```

3. **Create the tool wrapper.** Create a `CommandTool` subclass that defines how the LLM interacts with the command:

```ts
// packages/engine/src/execution-agent/agent/tools/commands/my-command.tool.ts
import { CommandTool } from "../command-tool";
import type { MyCommandSpec } from "../../../../commands/commands/my-command/my-command.def";

export class MyCommandTool extends CommandTool<MyCommandSpec, YourContext> {
  protected inputSchema() { return myCommandParamsSchema; }
  description() { return "Description shown to the AI model"; }
  protected async extractParams(input, context) { return input; }
}
```

4. **Register it.** Add the tool to the command tools array in your `ExecutionAgentFactory` subclass.

5. **Add the spec to the union type** in `packages/engine/src/commands/command-defs.ts` so TypeScript knows about it.

## Extending for a New Platform

1. **Implement all driver interfaces** using your platform's SDK. At minimum you need `ScreenDriver` and `ApplicationDriver` (the `BaseCommandContext`). Add `MouseDriver`, `KeyboardDriver`, `NavigationDriver`, and `ClipboardDriver` as needed.

2. **Create an `Installer` subclass** that builds the context. The installer receives application data (URL, device config, etc.) and returns the context with all drivers, plus an `ImageStream` and `VideoRecorder`:

```ts
class MyPlatformInstaller extends Installer<MyAppData, MyContext> {
  async install(appData: MyAppData) {
    // Launch browser/device, create driver instances
    return { context, imageStream, videoRecorder };
  }
}
```

3. **Create an `ExecutionAgentFactory` subclass** that builds the agent with platform-specific command tools:

```ts
class MyPlatformAgentFactory extends ExecutionAgentFactory<MySpec, MyContext> {
  async buildAgent(params) {
    return new ExecutionAgent({
      model: this.model,
      systemPrompt: this.systemPrompt,
      maxSteps: 50,
      commandTools: [new ClickTool(...), new TypeTool(...), ...],
      // ...rest of config
      ...params,
    });
  }
}
```

4. **Create a runner entry point** that wires the installer, factory, and event handlers together using `ExecutionAgentRunner`.

## The Runner and Artifacts

`ExecutionAgentRunner` orchestrates a full test run:

1. Calls `Installer.install()` to build the platform context (browser/device + drivers)
2. Registers a frame handler for live streaming
3. Builds the `ExecutionAgent` via the factory
4. Wraps `agent.generate()` in `VideoRecorder.withRecording()`
5. Returns `{ result, videoPath }`

`LocalRunner` extends this for local development - it loads test cases from markdown files and saves artifacts to disk:

```
artifacts/{timestamp}-{testName}/
├── screenshots/step-0-before.jpeg, step-0-after.jpeg, ...
├── steps.json          # Array of step execution outputs
├── conversation.json   # Sanitized AI turn log
├── instruction.txt     # The test prompt
└── video.{ext}         # Recording
```

## Result Types

**`GeneratedStep<TSpec>`** - one step of execution:
- `executionOutput` - the command's step data (interaction + params) and result
- `waitCondition` - an optional wait condition for replay
- `beforeMetadata` / `afterMetadata` - screenshots and other metadata from before/after the step

**`ExecutionResult<TSpec>`** - the full test result:
- `generatedSteps` - all steps
- `memory` - final state of extracted variables
- `success` - whether the test passed
- `finishReason` - `"success"`, `"max_steps"`, or `"error"`
- `reasoning` - the model's explanation for finishing
- `conversation` - the full AI message history

**`LeanExecutionResult<TSpec>`** - a network-safe version that strips large image buffers from step metadata.

## Test Cases as Markdown

Test files use [gray-matter](https://github.com/jonschlinkert/gray-matter) frontmatter for parameters, with the body containing the natural language prompt:

```markdown
---
url: https://example.com
---
Navigate to the login page, enter "user@test.com" and "password123",
click Sign In, and assert the dashboard is visible.
```

The `loadTestCase` function parses the frontmatter against a Zod schema and extracts the prompt from the body. It also walks up the directory tree looking for an `autonoma/skills/` directory to auto-load skill definitions.
