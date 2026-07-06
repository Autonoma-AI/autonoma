---
title: Previewkit
description: Vercel-style preview environments for every pull request. Configure your stack in the Autonoma dashboard, open a PR, get a live URL.
---

<p class="lead">Previewkit gives every pull request its own live, isolated, full-stack preview of your app. It's the foundation Autonoma reviews run against - and the first thing you set up when you connect a repo.</p>

![A pull request gets an isolated preview environment with its apps, database, and cache, and a live URL posted back to the PR](/img/previewkit/lifecycle.jpg)

You describe your stack once - apps, the services they depend on, and their environment variables - and Previewkit handles the rest: building the containers, provisioning the supporting services, wiring environment variables, and posting the URL back to the PR.

## How it works

Once the Previewkit GitHub App is installed on your repository, every `pull_request` event triggers the pipeline:

1. **Opened / synchronized / reopened** - Previewkit fetches the head commit, builds each app, provisions service recipes (Postgres, Redis, etc.), deploys to a dedicated Kubernetes namespace, and comments the preview URL on the PR.
2. **Closed** - Previewkit deletes the namespace and all resources tied to that PR, then updates the comment.

Each preview gets a stable, unguessable URL - a short hash derived from the service name, PR number, and repo, so the same PR always resolves to the same address. One PR may expose several apps, each with its own hostname under `preview.autonoma.app`.

A repository can also have a standing **main-branch environment**: a preview deployed from the repository's main branch instead of a PR. Once it exists, every push to that branch redeploys it at the new head automatically, the same way a new commit updates a PR's preview.

## What you configure

You set up your stack in the Autonoma dashboard (the Previewkit onboarding flow), which walks through four steps - **Apps**, **Services**, **Env vars and secrets**, and **Hooks** - and saves the configuration for your repository. Apps and services are auto-detected from your repo and suggested for you (accept, edit, or dismiss), and you can add them by hand too. It declares:

- **Apps** to build and deploy (each becomes a public HTTPS URL)
- **Services** the apps depend on (databases, caches, etc.), picked from a curated catalog of recipes
- **Environment variables and secrets** for each app and service, with templates that resolve service hostnames at deploy time and a per-row toggle to mark a value as a secret
- **Hooks** that run after deploy (typical use: database migrations)

## Builds work out of the box

Previewkit auto-detects how to build each app:

- If a `Dockerfile` exists in the app's directory (or you specify one explicitly), it builds with [BuildKit](https://github.com/moby/buildkit).
- Otherwise it falls back to [Railpack](https://railpack.com), which detects Node, Python, Go, Ruby, Rust, PHP, Java, and more, and produces a working image without you writing any Dockerfile.

Images are pushed to a private registry and pulled by the preview cluster. You never touch credentials.

## Secrets

Secrets such as API keys and third-party tokens are stored encrypted and kept out of your stack configuration. Flag any value as a secret with the per-row toggle in the onboarding **Env vars and secrets** step, or manage them out-of-band via the REST API (handy for CI and rotating values without editing the config). They can be owner-scoped (every PR sees them) or PR-scoped (just this PR, useful for testing prod credentials in isolation). Previewkit also injects a few [built-in environment variables](/previewkit/secrets/#built-in-environment-variables) (`AUTONOMA_PREVIEWKIT`, `AUTONOMA_PREVIEWKIT_PR`, `AUTONOMA_PREVIEWKIT_URL`) into every preview so your app can detect it's running in a preview. See [Secrets](/previewkit/secrets/).

## What's next

- [Manage secrets](/previewkit/secrets/) - REST API reference
