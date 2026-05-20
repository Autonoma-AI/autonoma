---
title: "Step 1: Generate Knowledge Base"
description: "Analyze your codebase to produce AUTONOMA.md and features.json. This is the first step of the pipeline and feeds every step that follows."
---

The knowledge base generator is the **first step** of the pipeline. It reads your frontend codebase and produces a user-perspective guide to every important page, flow, and interaction in your application.

Because this runs first, every subsequent step (entity audit, scenarios, environment factory, validation, and test generation) builds on the understanding captured here. Getting the core flows right in this step is the single highest-leverage thing you can do for the quality of the final suite.

## Prerequisites

- Your application codebase must be available in the workspace.
- These environment variables in the Claude Code session: `AUTONOMA_API_KEY`, `AUTONOMA_PROJECT_ID`, `AUTONOMA_API_URL`.

## What this produces

- `autonoma/AUTONOMA.md`
- `autonoma/features.json`

## What to review

The most important output is the **core flows** table. Core flows are the workflows that receive the heaviest test coverage later in the pipeline.

When reviewing:

- check that the product areas are named the way your team names them
- confirm the true core flows are marked as core
- make sure obvious high-value flows were not missed

If the core flows are wrong, the rest of the suite will be prioritized incorrectly.

## The prompt

<details>
<summary>Expand full prompt</summary>

# Knowledge Base Generator

You generate a structured knowledge base for a codebase. Your output MUST be written to `autonoma/AUTONOMA.md` with YAML frontmatter.

## Instructions

1. All Autonoma documentation MUST be fetched via `curl` in the Bash tool. Do NOT use WebFetch. Do NOT write any URL yourself. The docs base URL lives only in `autonoma/.docs-url`, written by the orchestrator before any subagent runs.

   ```bash
   curl -sSfL "$(cat autonoma/.docs-url)/llms/<path>"
   ```

   If `curl` exits non-zero for any reason, **STOP the pipeline** and report the exit code and stderr. Do not invent a URL.

2. Fetch the latest knowledge base generation instructions:

   ```bash
   curl -sSfL "$(cat autonoma/.docs-url)/llms/test-planner/step-1-knowledge-base.txt"
   ```

3. Create the output directory:

   ```bash
   mkdir -p autonoma
   ```

4. Follow the fetched instructions to analyze the codebase — discover the application, map pages and flows, identify core workflows.

5. Write `autonoma/AUTONOMA.md`.

6. Write `autonoma/features.json` — a machine-readable inventory of every feature discovered.

## Output format

`autonoma/AUTONOMA.md` MUST start with YAML frontmatter:

```yaml
---
app_name: "Name of the application"
app_description: "2-4 sentences describing what the application does, who uses it, and its primary purpose."
core_flows:
  - feature: "Feature Name"
    description: "What this feature/area does"
    core: true
  - feature: "Settings"
    description: "User and org settings management"
    core: false
feature_count: 12
---
```

### What makes a flow "core"

A flow is core if: "If this flow broke silently, would users immediately notice and stop using the product?" Typically 2-4 flows are core. They receive 50-60% of test coverage.

### features.json

```json
{
  "features": [
    { "name": "Login", "type": "page", "path": "/login", "core": true },
    { "name": "Dashboard", "type": "page", "path": "/dashboard", "core": true }
  ],
  "total_features": 2,
  "total_routes": 2,
  "total_api_routes": 0
}
```

`type` is one of `page`, `api`, `flow`, `component`, `modal`, `settings`. `core` must match `core_flows` in the AUTONOMA.md frontmatter.

## Validation

A hook script validates your output on every write. If validation fails, fix the issue and rewrite.

Checks:
- File starts with `---` (YAML frontmatter)
- Frontmatter contains all required fields
- `core_flows` is a non-empty list with feature/description/core fields
- At least one flow has `core: true`
- `feature_count` is a positive integer
- `app_description` is at least 20 characters

## Important

- Use subagents for parallel exploration of the codebase
- Treat README files as hints, not ground truth — the codebase is the source of truth
- Document what you find, don't invent features
- Use the UI vocabulary — the same names the app uses

</details>
