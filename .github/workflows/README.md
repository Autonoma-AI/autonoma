# Deployment Workflows

## Overview

Production deployments use [release-please](https://github.com/googleapis/release-please) for semantic versioning and automatic changelog generation.

## Workflows

### 1. **Release Please** (`release-please.yml`)
- Triggers on every push to `main`
- Creates/updates a release PR with changelog
- When the release PR is merged, creates a GitHub release
- Uses conventional commits to determine version bump

### 2. **Production Build** (`production-build.yml`)
- Triggers when a GitHub release is published
- Builds and deploys all services to production
- Tags Docker images with the release version (e.g., `v1.2.3`)
- Captures deployed image versions
- Attaches deployment manifest to the release

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
- Manual workflow to sync to public repository
- Only runs when manually triggered

## How to Deploy

### Standard Release Flow

1. **Make changes** on feature branches with conventional commits:
   - `feat:` for new features (minor version bump)
   - `fix:` for bug fixes (patch version bump)
   - `feat!:` or `fix!:` with breaking changes (major version bump)

2. **Merge to `main`** - Release-please creates/updates a release PR

3. **Review the release PR** - Check the generated changelog and version bump

4. **Merge the release PR** - This creates a GitHub release and triggers production deployment

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
