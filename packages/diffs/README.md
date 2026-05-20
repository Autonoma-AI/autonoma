# @autonoma/diffs

AI agent that analyzes code diffs on pull requests. It reviews changes, runs affected tests, reports bugs, suggests test modifications, and identifies test coverage gaps - all autonomously using LLM tool-calling.

## How It Works

The `DiffsAgent` wraps the Vercel AI SDK's `ToolLoopAgent`. Given a diff summary and existing tests, it:

1. Explores the actual patch using git commands (`bash`, `glob`, `grep`, `read_files`)
2. Runs potentially affected tests via `run_test`
3. Takes post-run actions per test: `modify_test`, `remove_test`, or `bug_found`
4. Identifies new functionality with no test coverage and suggests new tests via `add_test`
5. Calls `finish` with an overall reasoning summary

The agent retries up to 3 times if it produces no actions.

## Exports

```ts
// Core agent
import {
  DiffsAgent,
  type DiffsAgentConfig,
  type DiffsAgentInput,
  type DiffAnalysis,
  type ExistingTestInfo,
  type TestRunResult,
} from "@autonoma/diffs";

// Result types
import type {
  DiffsAgentResult,
  TestAction,
  ResultCollector,
  BugReport,
  GeneratedTest,
} from "@autonoma/diffs";

// Callbacks (wiring agent actions to real side effects)
import {
  createCallbacks,
  type CreateCallbacksParams,
  type DiffsAgentCallbacks,
} from "@autonoma/diffs";
```

## Usage

```ts
import { DiffsAgent } from "@autonoma/diffs";
import { createCallbacks } from "@autonoma/diffs";

// 1. Create callbacks that wire agent actions to real side effects
const callbacks = createCallbacks({
  db,               // PrismaClient
  updater,          // TestSuiteUpdater from @autonoma/test-updates
  applicationId,
  workingDirectory, // repo checkout path
  repoId,           // GitHub repository ID
  headSha,
  octokit,          // GitHub installation client
});

// 2. Create the agent
const agent = new DiffsAgent({
  model,              // Vercel AI SDK LanguageModel
  workingDirectory,   // repo checkout path
  callbacks,
});

// 3. Run analysis
const result = await agent.analyze({
  analysis: {
    affectedFiles: ["src/auth/login.ts", "src/auth/login.test.ts"],
    summary: "Refactored login flow to use OAuth2 instead of basic auth",
  },
  existingTests: [
    { id: "t1", name: "Login flow", slug: "login-flow", prompt: "Navigate to login..." },
  ],
});

// 4. Use results
console.log(result.reasoning);
console.log(result.testActions);    // modify or remove actions taken
console.log(result.bugReports);     // bugs introduced by the PR
console.log(result.newTests);       // suggested new tests
```

## Tools

The agent has two categories of tools:

### Codebase Exploration

| Tool | Description |
|------|-------------|
| `bash` | Shell commands (git diff, git show, etc.) scoped to the working directory |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `read_files` | Read one or more files in a single call (batch all paths into one array) |
| `subagent` | Spawn a focused research subagent for parallel investigation |

### Actions

| Tool | Description | Prerequisite |
|------|-------------|--------------|
| `run_test` | Trigger test execution and wait for results | None |
| `modify_test` | Update a test instruction to match new behavior | `run_test` |
| `remove_test` | Remove a test from the suite when its flow was deleted | `run_test` |
| `bug_found` | Report a bug introduced by the PR with a fix prompt | `run_test` |
| `add_test` | Suggest a new test for uncovered functionality | None |
| `finish` | End analysis with overall reasoning | None |

Post-run tools (`modify_test`, `remove_test`, `bug_found`) enforce that `run_test` was called first for the given test slug.

## Callbacks

The `DiffsAgentCallbacks` interface decouples agent decisions from side effects. The `createCallbacks` factory wires them to real implementations:

- `triggerTestsAndWait` - Triggers parallel test execution via Temporal workflows, polls for completion, returns results
- `removeTest` - Removes obsolete tests from the suite
- `modifyTest` - Updates test instruction in the database via `TestSuiteUpdater`
- `reportBug` - Creates a GitHub issue on the repository via Octokit

## Architecture

```
src/
  index.ts                  # Package re-exports
  diffs-agent.ts            # DiffsAgent class, prompt construction, system prompt
  callbacks.ts              # Re-exports from callbacks/
  callbacks/
    create-callbacks.ts     # Factory wiring DiffsAgentCallbacks to real implementations
    modify-test.ts          # Database update for test modifications
    report-bug.ts           # GitHub issue creation via Octokit
  tools/
    index.ts                # Re-exports all tool builders
    codebase-tools.ts       # Groups exploration and action tools
    bash-tool.ts            # Sandboxed shell execution
    glob-tool.ts            # File pattern matching
    grep-tool.ts            # Content search
    read-file-tool.ts       # File reading
    subagent-tool.ts        # Spawns focused research subagents
    run-test-tool.ts        # Triggers test execution
    modify-test-tool.ts     # Modifies test instructions
    remove-test-tool.ts     # Removes tests whose flow no longer exists
    bug-found-tool.ts       # Reports bugs with fix prompts
    add-test-tool.ts        # Suggests new tests
    finish-tool.ts          # Ends analysis, collects results
```

## Testing

```bash
pnpm test          # run unit tests
pnpm eval          # run evals (sets RUN_EVALS=true)
```

Tests cover individual tools in isolation using a fixture repo (`test/fixtures.tar.gz`). Evals run the full agent against real diffs.
