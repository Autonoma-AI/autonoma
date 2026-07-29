---
title: Preview environments
description: Vercel-style preview environments for every pull request. Configure your stack in the Autonoma dashboard, open a PR, get a live URL.
---

<p class="lead">Preview environments give every pull request its own live, isolated, full-stack preview of your app. They're the foundation Autonoma reviews run against - and the first thing you set up when you connect a repo.</p>

![A pull request gets an isolated preview environment with its apps, database, and cache, and a live URL posted back to the PR](/img/preview-environments/lifecycle.jpg)

You describe your stack once - apps, the databases they need, and their environment variables - and Autonoma handles the rest: building the containers, provisioning the databases and extra services, running setup tasks, wiring environment variables, and posting the URL back to the PR.

## How it works

Once the Autonoma GitHub App is installed on your repository, every `pull_request` event triggers the pipeline:

1. **Opened / synchronized / reopened** - Autonoma fetches the head commit, builds each app, provisions the databases and extra services it needs, runs the database setup tasks, deploys to a dedicated Kubernetes namespace, and comments the preview URL on the PR.
2. **Closed** - Autonoma deletes the namespace and all resources tied to that PR, then updates the comment.

Each preview gets a stable, unguessable URL - a short hash derived from the service name, PR number, and repo, so the same PR always resolves to the same address. One PR may expose several apps, each with its own hostname under `preview.autonoma.app`.

A repository can also have a standing **main-branch environment**: a preview deployed from the repository's main branch instead of a PR. Once it exists, every push to that branch redeploys it at the new head automatically, the same way a new commit updates a PR's preview.

## What you configure

You set up your stack in the Autonoma dashboard (the preview environment onboarding flow), which saves the configuration for your repository. The flow leads with a coding agent: pair your agent to the app and it fills the configuration in for you, while you watch read-only. See [Set up a preview with a coding agent](/mcp/configure-preview/) for that path - the rest of this section describes what it is configuring, and applies either way.

To fill it in yourself, take **Configure manually** on that screen. The manual flow has four required steps - **Apps**, **Database**, **Variables**, and a **Review** step that confirms the configuration and deploys it - plus two optional pieces most projects never need. It declares:

- **Apps** to build and deploy (each becomes a public HTTPS URL) - see [Apps and builds](/preview-environments/apps/)
- **Databases** the apps need (Postgres, MySQL, MongoDB, Redis / Valkey), each with guided setup for schema, seed data, and migrations - see [Databases](/preview-environments/databases/)
- **Variables** - environment variables and secrets for each app and database, with templates that resolve hostnames at deploy time and a per-variable **Source** control choosing whether a value is a stored secret or a connection to something else in the preview
- **Extra services** (optional) - non-database Docker images like Sentry or an OTel collector - see [Extra services](/preview-environments/services/)
- **Lifecycle hooks** (optional) - commands that run around each deploy - see [Lifecycle hooks](/preview-environments/hooks/)

Extra services and lifecycle hooks sit off the main path: the flow finishes at Variables, and you reach them only if your setup needs them.

## How apps are built

Each app builds one of two ways, chosen per app:

- **Manual** - pick a runtime (Node, Python, Go, and more), then write a short bash build script and an entrypoint. No Dockerfile required.
- **Dockerfile** - point Autonoma at an existing Dockerfile in your repo, built with [BuildKit](https://github.com/moby/buildkit).

Either way, images are pushed to a private registry and pulled by the preview cluster - you never touch credentials. See [Apps and builds](/preview-environments/apps/) for the full reference.

## Secrets

Secrets such as API keys and third-party tokens are stored encrypted and kept out of your stack configuration. Flag any value as a secret with the **Source** control in the onboarding **Variables** step, or manage them out-of-band via the REST API (handy for CI and rotating values without editing the config). They can be owner-scoped (every PR sees them) or PR-scoped (just this PR, useful for testing prod credentials in isolation). Autonoma also injects a few [built-in environment variables](/preview-environments/secrets/#built-in-environment-variables) (`AUTONOMA_PREVIEWKIT`, `AUTONOMA_PREVIEWKIT_PR`, `AUTONOMA_PREVIEWKIT_URL`) into every preview so your app can detect it's running in a preview. See [Secrets](/preview-environments/secrets/).

## What's next

- [Apps and builds](/preview-environments/apps/) - build methods, runtimes, and per-app settings
- [Databases](/preview-environments/databases/) - engines, guided setup tasks, and where they run
- [Extra services](/preview-environments/services/) - non-database side containers
- [Lifecycle hooks](/preview-environments/hooks/) - commands that run around each deploy
- [Multiple repositories](/preview-environments/multirepo/) - pull apps from more than one repository
- [Manage secrets](/preview-environments/secrets/) - REST API reference
