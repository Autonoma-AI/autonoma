---
title: Lifecycle hooks
description: Commands that run around each deploy of the whole preview - pre-deploy before your apps start, post-deploy once they're ready.
---

<p class="lead">Lifecycle hooks are commands Autonoma runs around each deploy of the whole preview: before your apps start, and after they're ready. Most projects never need them.</p>

![A preview deploy runs the pre-deploy hooks as one-off jobs, then the apps start, then the post-deploy hooks run as one-off jobs](/img/preview-environments/hooks-timeline.jpg)

Think of a hook as a step that belongs to the preview itself, not to any single app or database. When a preview deploys, Autonoma runs your pre-deploy hooks, brings the apps up, then runs your post-deploy hooks. Both groups are optional, and you add as many commands to each as you like.

## Pre-deploy and post-deploy

Hooks live in two groups, chosen by when you need them to run:

| Group | When it runs | Good for |
| --- | --- | --- |
| **Pre-deploy** | Before your apps start. | Cache warmup, feature-flag sync. |
| **Post-deploy** | After your apps are ready. | A smoke test, notifying Slack. |

**Every hook belongs to an app**, which is what decides the image its command runs in. A hook is a
one-off Kubernetes Job launched from that app's built image, so the command has that app's code,
dependencies and secrets available - and nothing else. Picking the app is required; the config will
not save without it.

A pre-deploy hook runs before the apps start. A post-deploy hook runs once **its own** app is ready -
not once every app is. Two things follow that are easy to get wrong:

- A post-deploy hook whose app never came up is **skipped silently** (the deploy itself then fails,
  since a preview only publishes when every app is ready).
- A failing post-deploy hook does **not** fail the deploy. It is reported as a warning on the PR
  comment and the preview is still published, so a smoke test here will not gate anything.

:::caution[The built-in variables are not available in a hook]
`AUTONOMA_PREVIEWKIT`, `AUTONOMA_PREVIEWKIT_PR` and `AUTONOMA_PREVIEWKIT_URL` are injected into your
running app containers only. A hook Job gets its app's secrets and resolved connections, and none of
those three - so a command like `curl "$AUTONOMA_PREVIEWKIT_URL/health"` sees an empty string.
:::

## Migrations: prefer the database's own setup

You *can* run a migration from a pre-deploy hook - it is a documented use, and the hook's own help text
in the dashboard suggests it. Prefer putting it on the database instead.

A database's setup tasks are owned by that database, so Autonoma runs them at the right moment for it,
and each database carries its own schema and seed data rather than one preview-wide step doing
everything. Reach for a pre-deploy hook when the work genuinely spans the preview, or when it does not
belong to any single database. See [databases](/preview-environments/databases/) for where setup
commands go.

## Optional by design

Hooks sit off the main onboarding flow - you reach them through the optional tab, or the "finish here" fork on the Variables step. Skip them entirely if your preview doesn't need work around its deploys, and come back to add one whenever you do.
