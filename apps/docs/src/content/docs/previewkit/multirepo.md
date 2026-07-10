---
title: Multi-repo previews
description: Deploy apps from more than one repository into a single preview environment, and control which branch of each dependency repo gets built.
---

<p class="lead">Most projects live in one repository, but when your backend, workers, or a shared service sit in their own repos, Previewkit can pull them into the same preview so a pull request gets a complete, wired-up environment.</p>

## Dependency repos

Your app's own repository is the **primary repo** - the one the pull request is opened against. A **dependency repo** is any other repository whose apps you want deployed alongside it, into the same preview environment for that PR.

You add a dependency repo while adding an app: when you add an app, you pick which repo it comes from, or connect a new repo through the Previewkit GitHub App. Each dependency repo carries two settings:

- **Alias** - a short, lowercase name (e.g. `api`) used to identify the repo in your config and in generated resource names. It has to be unique across your repos.
- **Fallback branch** - the branch to deploy when branch matching can't find a matching branch (see below). Defaults to `main`.

All of a repo's apps share these two settings.

## Which branch gets deployed

For the primary repo the answer is obvious: the pull request's own branch. For a dependency repo it's not - the PR branch usually doesn't exist there. **Branch matching** is the single rule that decides which branch of every dependency repo Previewkit builds for a given PR.

If the branch it picks doesn't exist in the dependency repo, Previewkit always falls back to that repo's **fallback branch**, so a preview never fails just because a dependency repo doesn't have a matching branch.

| Branch matching | For a PR on branch `feature/x`, a dependency repo builds... |
| --- | --- |
| **Same branch name** (default) | `feature/x` if that branch exists in the dependency repo, otherwise the fallback branch. Use this when you develop a feature across both repos on branches with the same name. |
| **Fallback branch only** | Always the fallback branch (e.g. `main`). Use this when the dependency repo is a stable service you don't branch per feature. |
| **Regex rewrite** | A branch name derived by rewriting `feature/x` with a regular expression (e.g. strip a `feature/` prefix), falling back if the result doesn't exist. Use this when your two repos follow different but predictable branch conventions. |

Branch matching is set once and applies to every dependency repo in the project; the fallback branch is per repo.

:::note
Branch matching only affects **dependency** repos. The primary repo always builds the pull request's own branch.
:::
