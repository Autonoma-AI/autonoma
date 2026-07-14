---
name: watch-opencode
description: "Watch a PR's OpenCode review and notify the user when it finishes. Polls the OpenCode workflow run (opencode-review.yml, or the /oc-triggered opencode-comment.yml) until it settles - following supersede when a new push cancels an in-flight review - then reads OpenCode's comment, summarizes its findings, and pings the user via their preferred method (default: a completion chime + treemux attention + an in-chat summary). Use when the user wants to be told when the OpenCode bot is done reviewing a PR, e.g. 'watch the opencode review and let me know when it's done', 'ping me when opencode finishes on PR 1485'."
---

# Watch OpenCode

Wait until the **OpenCode** bot has finished reviewing a pull request, then tell the user what it found. OpenCode runs as a GitHub Action (`anomalyco/opencode/github`) and posts its output as a top-level PR comment authored by `github-actions[bot]`. This skill blocks on the run in the background, so it costs almost nothing while waiting and wakes you exactly once - when OpenCode is done.

## What "done" means here

OpenCode never literally writes "done". Each run posts **one fresh issue comment** with its findings (or a short "nothing to raise" note), so the authoritative completion signal is the **workflow run status**, not the comment text. Two workflows can produce that comment:

- **`opencode-review.yml`** ("PR Review") - the automatic reviewer. Runs on every push (`synchronize`) and uses `cancel-in-progress` concurrency, so a new push **cancels the in-flight review and starts a new one**. This skill follows that chain and only reports the review of the current tip.
- **`opencode-comment.yml`** ("OpenCode Comment Trigger") - fires when someone comments `/oc` or `/opencode`; this OpenCode can also push commits.

The helper script handles both and resolves the most recent run automatically.

## Steps

### 1. Resolve the PR

- If the user gave a PR number or URL, use it.
- Otherwise use the current branch's PR: `gh pr view --json number,url,headRefName,state`.
- If there is no PR, tell the user and stop.

Store the PR **number** (call it `PR`).

Sanity-check that OpenCode will actually run: the review is **skipped on draft PRs, bot-authored PRs, and fork PRs** (see `opencode-review.yml`). If the PR is a draft, say so - OpenCode won't review it until it's marked ready.

### 2. Launch the watcher in the background

Run the helper **in the background** (`run_in_background: true`) so it survives past a single turn and re-invokes you when OpenCode settles:

```bash
.claude/skills/watch-opencode/scripts/watch-opencode.sh <PR>
```

It blocks until the newest OpenCode run on the PR's branch is `completed` and no superseding run is pending, then prints one line:

```
OPENCODE_RESULT {"runId":..,"status":"completed","conclusion":"success","headSha":..,"url":..,"name":"PR Review"}
```

Notable `conclusion` values:
- `success` / `failure` / `cancelled` - the run's real conclusion.
- `none` - no OpenCode run exists for this PR (draft / fork / bot PR, or nothing triggered it). Report that instead of waiting further.
- `timeout` - the safety backstop (~75 min) fired before it settled; re-launch or investigate.

Do **not** poll it yourself with `sleep` loops - the background process notifies you on exit. If you need a fallback heartbeat, `ScheduleWakeup` at a long interval (1200s+), but normally just wait for the completion notification.

### 3. Read OpenCode's comment

Once the watcher exits, fetch the newest `github-actions[bot]` issue comment on the PR - that's OpenCode's output for this run:

```bash
gh api "repos/{owner}/{repo}/issues/<PR>/comments" \
  --jq '[.[] | select(.user.login=="github-actions[bot]")] | last | {body, html_url, created_at}'
```

- If `conclusion` was `success` but the comment predates the run, the run may have posted nothing new - link the run (`url`) so the user can check logs.
- If `conclusion` was `failure`, OpenCode errored (often an OpenRouter/model hiccup) and likely posted no findings - report the failure with the run URL, don't invent findings.

Read the comment body and distill it: the real bugs/security/perf/UX items (lines prefixed `[BUG]`, `[SECURITY]`, `[PERF]`, `[UX]`, `[CONVENTION]`, etc.), separating genuine findings from a "nothing to raise" all-clear.

### 4. Notify the user

Notify via the user's **preferred method if they named one** (e.g. they said "ping me on Slack"); otherwise use the **default**:

1. **Completion sound** (macOS): `afplay /System/Library/Sounds/Glass.aiff`
2. **treemux attention** so the sidebar flags this worktree: call `needs_attention` with a one-line summary (the user may be on another worktree).
3. **In-chat summary**: PR link, run conclusion, and OpenCode's key findings as a short bulleted list, with a link to the full comment (`html_url`). If OpenCode raised nothing, say so plainly.

Set treemux status to `done` (or `error` if the run failed).

## Notes

- Everything here is **read-only** on GitHub - the skill never comments, pushes, or re-triggers anything. It only observes.
- OpenCode posts a **new comment per run**, so "the latest `github-actions[bot]` comment" is this run's output; older comments are prior reviews of earlier commits.
- If the user keeps pushing, the watcher keeps following the supersede chain and reports only once the tip's review settles - which is usually what "tell me when it's done" means.
