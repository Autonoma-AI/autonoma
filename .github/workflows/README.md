# Deployment Workflows

## Overview

Production deployments use [release-please](https://github.com/googleapis/release-please) for semantic versioning and automatic changelog generation.

## Workflows

### 1. **Release Please** (`release-please.yml`)
- Triggers on every push to `main`
- Creates/updates a release PR with changelog
- When the release PR is merged, creates a GitHub release
- Uses conventional commits to determine version bump
- **Multi-component**: tracks two independently-versioned packages
  - root (`.`) -> tags like `v1.8.9`, drives the production k8s deploy below
  - CLI (`apps/cli`, `@autonoma-ai/planner`) -> tags like `cli-v0.1.14`, drives the npm publish below
- `separate-pull-requests: true`, so the root and the CLI each get their own release PR

### 2. **Production Build** (`production-build.yml`)
- Triggers when a GitHub release is published
- **Guarded to root `v*` releases only** - `cli-v*` releases skip the deploy entirely
- Builds and deploys all services to production
- Tags Docker images with the release version (e.g., `v1.2.3`)
- Captures deployed image versions
- Attaches deployment manifest to the release

### 2b. **Publish CLI to npm** (`cli-publish.yml`)
- Triggers when a GitHub release is published
- **Guarded to `cli-v*` releases only** - root `v*` releases never publish to npm
- Verifies the tag is on `main`, then typechecks/tests/builds `@autonoma-ai/planner`
- Idempotently publishes to npm (skips if the version is already published)
- Requires the `CLI_NPM_TOKEN` repo secret (an npm token with publish rights to `@autonoma-ai/planner` and 2FA bypass enabled)

### 2c. **Publish CLI canary to npm** (`cli-canary.yml`)
- Triggers on push to the `cli-canary` branch (apps/cli changes), a daily schedule, or manual dispatch
- Publishes `@autonoma-ai/planner` under the `canary` dist-tag as `<next-patch>-canary.<sha>`
- Never touches release-please tags/manifest; the stable `@latest` channel is untouched
- Scoped to the CLI only - bumps and publishes `apps/cli` and nothing else; also uses `CLI_NPM_TOKEN`

### 3. **Production Rollback** (`production-rollback.yml`)
- Manual workflow to rollback to a previous version
- Accepts optional `version` parameter (e.g., `v1.2.3`)
- If no version specified, rolls back to the previous deployed release
- Restores all services and job images from the deployment manifest

### 4. **List Production Releases** (`list-production-releases.yml`)
- Manual workflow to view all deployed releases
- Shows deployment timestamps and image versions
- Provides rollback commands for each release

### 5. **Promote to Production** (`promote-to-production.yml`)
- Manual workflow to promote beta to production
- Force-pushes `main` branch to `production` branch
- Optional checkbox to trigger a release after promotion

### 6. **Sync to Public Mirror** (`sync-public.yml`)
- Triggers automatically when a root `v*` GitHub release is published (i.e. the root Release Please PR is merged) and can also be run manually
- **Guarded to root `v*` releases only** - `cli-v*` releases never trigger a sync
- Replays each new private commit onto the public repo (stripping `.opensource-ignore` paths), preserving original author/committer, then appends a `Source-Commit` marker commit

### 7. **PR Title Suggest** (`pr-title-suggest.yml`)
- Triggers on `pull_request` events against `main` and on `issue_comment` edits
- Calls Amazon Bedrock (Claude Haiku 4.5) with the PR title, body, commits, and diff stat
- If the title is vague or not a valid conventional commit, posts a comment with a suggested rewrite and a checkbox
- When a collaborator ticks the checkbox, the workflow applies the new title via `gh pr edit`
- The existing CI check (`validate-pr-title`) still enforces the conventional commit format; this workflow helps authors get to a good title quickly

### 8. **PR Review Slack Notification** (`pr-review-notify.yml`)
- Triggers on `pull_request` events (`opened`, `reopened`, `ready_for_review`) and only runs when the PR is not a draft, so it fires exactly when a PR is set for review
- Posts a Block Kit message to Slack channel `C09R1PEH41M` with the PR link and title
- Uses `chat.postMessage` (not an incoming webhook) so the message can be targeted at the channel by ID
- Uses `SLACK_USER_TOKENS` when available to post as the PR author, falling back to `SLACK_BOT_TOKEN`
- Stores the Slack message `ts` as a 90-day Actions artifact named `pr-slack-thread-<PR number>`, so approval notifications can reply under the original Slack message
- Requires either a `SLACK_USER_TOKENS` JSON map or a `SLACK_BOT_TOKEN` repo secret. The bot token needs `chat:write` and the app must be invited to the target channel. If no usable secret is available the step skips gracefully (e.g. on fork PRs, where secrets are not exposed)

### 9. **PR Approval Slack Notification** (`pr-approval-slack-notify.yml`)
- Triggers on `pull_request_review` `submitted` events and only runs for human `approved` reviews on non-draft, non-bot PRs
- Finds the newest trusted `pr-slack-thread-<PR number>` artifact created by a successful `pr-review-notify.yml` run, reads its Slack channel ID and parent `thread_ts`, then replies `Approved` and reacts to the parent message with `:aprobaditto:`
- Uses a per-PR, per-reviewer concurrency group and marker artifact to skip duplicate approval replies from the same reviewer
- Uses `SLACK_USER_TOKENS` independently for the reply and reaction, falling back to `SLACK_BOT_TOKEN` for only the operation that fails. A missing reaction scope does not force the reply to use the bot
- Requires `chat:write` on the reply credential and `reactions:write` on the reaction credential. Existing user tokens must be reauthorized to react as the reviewer; otherwise the bot can add the reaction when it has the `reactions:write` bot scope
- Skips gracefully if the parent Slack thread artifact or Slack secrets are unavailable

### 10. **OpenCode PR Review** (`opencode-review.yml`)
- Triggers on `pull_request` events (`opened`, `reopened`, `ready_for_review`, `synchronize`) and only runs on non-draft, non-bot, same-repo PRs (fork PRs are skipped because secrets are not exposed to them)
- Runs the OpenCode GitHub Action (`anomalyco/opencode/github`, pinned to a commit SHA) with the `openrouter/z-ai/glm-5.2` model to review the diff and post comments only (it never modifies files)
- Authenticates the model with `OPENROUTER_API_KEY` and posts via the built-in `GITHUB_TOKEN` (`use_github_token: true`), so the OpenCode GitHub App does not need to be installed
- The prompt checks for bugs/security/edge cases, inefficient database queries (work that should be pushed down into Prisma/SQL instead of done in JS, and unbounded `findMany`/`SELECT` calls that risk OOM), missing frontend UX states in `apps/ui` (loading/skeleton, empty, and error states for data-driven views), convention violations against the root and nested `CLAUDE.md` files plus the `ui-conventions` skill, and documentation left stale by the change
- `cancel-in-progress` concurrency drops in-flight reviews when new commits land, so a burst of pushes does not pile up reviews
- Requires the `OPENROUTER_API_KEY` repo secret (already used by `ci.yml`)

### 11. **OpenCode Comment Trigger** (`opencode-comment.yml`)
- Triggers on `issue_comment` and `pull_request_review_comment` (`created`) events when the body contains `/oc` or `/opencode`
- Gated to commenters with write access (`author_association` of `OWNER`/`MEMBER`/`COLLABORATOR`) - anyone able to comment could otherwise push code and spend OpenRouter credits
- Runs the OpenCode build agent (`anomalyco/opencode/github`, pinned to a commit SHA) with `openrouter/z-ai/glm-5.2`, so it can make code changes, commit, and push to the PR branch (not just comment)
- Authenticates with `OPENROUTER_API_KEY` and the built-in `GITHUB_TOKEN` (`use_github_token: true`), so the OpenCode GitHub App does not need to be installed
- Note: `issue_comment`/`pull_request_review_comment` workflows only run from the version on the **default branch**, so this must be merged to `main` before comment triggers take effect

### 12. **ECR Cleanup** (`ecr-cleanup.yml`)
- Runs daily at 06:20 UTC and can also be started manually
- Deletes ECR images whose `lastRecordedPullTime` is older than 3 days, using `imagePushedAt` for images that have never been pulled
- Skips images with protected tags matching `^(latest|v[0-9].*)$` by default so current `latest` images and production release tags remain available
- Manual runs default to dry-run mode and support overriding the age threshold, repository prefix, and protected tag regex
- Requires the existing AWS service account secrets to allow `ecr:DescribeRepositories`, `ecr:DescribeImages`, and `ecr:BatchDeleteImage`

## How to Deploy

### Standard Release Flow

1. **Make changes** on feature branches with conventional commits:
   - `feat:` for new features (minor version bump)
   - `fix:` for bug fixes (patch version bump)
   - `feat!:` or `fix!:` with breaking changes (major version bump)

2. **Merge to `main`** - Release-please creates/updates a release PR

3. **Review the release PR** - Check the generated changelog and version bump

4. **Merge the release PR** - This creates a GitHub release, which triggers production deployment and the public mirror sync

### Manual Deployment

If you need to deploy without merging a release PR:

```bash
gh workflow run production-build.yml -f version=v1.2.3
```

### Rollback

Rollback to the previous release:
```bash
gh workflow run production-rollback.yml
```

Rollback to a specific version:
```bash
gh workflow run production-rollback.yml -f version=v1.2.3
```

### View Deployment History

```bash
gh workflow run list-production-releases.yml
```

Or view releases in GitHub: `https://github.com/your-org/agent/releases`

## Deployment Artifacts

Each production deployment attaches a `deployment-manifest.json` to the GitHub release containing:
- Timestamp
- Version
- Commit SHA
- Core deployment images (API, UI)
- Complete job images ConfigMap (automatically captures all entries)

The manifest automatically includes all job images from the `image-version` ConfigMap, so adding new job types requires no workflow changes.

This manifest is used by the rollback workflow to restore the exact state of a previous deployment.

## Blue-Green Deployment

Kubernetes maintains the last 3 ReplicaSets for each deployment (configured via `revisionHistoryLimit: 3`). When rolling back:
- Old ReplicaSets are scaled up instantly (warmed up at 0 replicas)
- New ReplicaSets are scaled down
- Zero-downtime switchover

## Configuration Files

- `.release-please-manifest.json` - Version tracking
- `release-please-config.json` - Release-please configuration
- `deployment/apps/*.yaml` - Kubernetes manifests with `revisionHistoryLimit`

## Conventional Commits

Release-please uses [conventional commits](https://www.conventionalcommits.org/) to determine version bumps:

| Commit Type | Version Bump | Changelog Section |
|-------------|--------------|-------------------|
| `feat:` | Minor (0.x.0) | Features |
| `fix:` | Patch (0.0.x) | Bug Fixes |
| `feat!:` or `BREAKING CHANGE:` | Major (x.0.0) | Breaking Changes |
| `perf:` | Patch | Performance Improvements |
| `refactor:` | None | Code Refactoring |
| `docs:` | None | Documentation |
| `chore:` | None | Hidden |
| `test:` | None | Hidden |

## Tips

- Use descriptive commit messages - they become your changelog
- Breaking changes must include `BREAKING CHANGE:` in the commit body or use `!` after the type
- Multiple commits are combined into a single release
- Release-please only creates a release when there are releasable changes
