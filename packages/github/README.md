# @autonoma/github

GitHub App integration primitives shared across the platform: the App/installation clients, PR and check-run
operations, branch-protection rulesets, and pure helpers for reasoning about commits and contributors. Depends
only on `@autonoma/db`, `@autonoma/logger`, and Octokit - no HTTP or app-server concerns live here.

## Exports

| Export | Purpose |
| --- | --- |
| `OctokitGitHubApp` / `GitHubApp` | The App: verify webhooks, mint per-installation clients. |
| `OctokitGitHubInstallationClient` / `GitHubInstallationClient` | Per-installation client: repos, PRs, commits, comments, check runs, rulesets. |
| `FakeGitHubApp` / `FakeGitHubInstallationClient` | In-memory doubles for tests (build repos/PRs/commits, inspect comments + check runs). |
| `LocalDevGitHubApp` / `LocalDevGitHubInstallationClient` | Fixed-response doubles for `LOCAL_DEV`. |
| `parseRepoFullName` | Split `"owner/repo"`. |
| `parseCoAuthoredByTrailers` | Parse `Co-authored-by: Name <email>` trailers out of a commit message. |
| `resolveContributorsFromCommits` / `contributorKey` | Collapse a PR's commits (+ opener) into a deduped `ResolvedContributor[]`. |

### Contributor resolution (`src/contributors/`)

Pure, side-effect-free helpers for the per-developer stickiness signal. A PR has more than one author, so its
outcome must attribute to all of them:

- `parseCoAuthoredByTrailers(message)` returns the `{ name, email }` co-authors declared in a commit message.
  GitHub never puts a login in a trailer, so co-authors carry only name/email; mapping an email back to a login
  is best-effort and not done here (GitHub only exposes a login when the commit email is linked to an account).
- `resolveContributorsFromCommits(commits, { openerLogin })` returns a deduped `ResolvedContributor[]` -
  every commit author (with a login where resolvable), every co-author (name/email only, no login), and the
  opener (flagged `isOpener`). `commits` need only satisfy `CommitForContributors` (`{ message, authorLogin? }`),
  which both `PullRequestCommit` and `Commit` do. `contributorKey(c)` is the stable identity used both for the
  in-memory dedup and the `BranchContributor` unique index: `login ?? email ?? displayName`, lowercased.
  `isUnresolved(c)` asks whether GitHub could map the contributor to an account (i.e. `login` is absent) - so a
  single human can appear twice (once by `login`, once by co-author `email`); dedupe by `login` where present.

The API-side orchestration that fetches commits and persists `BranchContributor` rows lives in
`apps/api/src/github/branch-contributor.service.ts`.

## Commands

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint --fix
pnpm test        # vitest
```
