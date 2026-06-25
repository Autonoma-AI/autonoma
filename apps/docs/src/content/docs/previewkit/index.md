---
title: Previewkit
description: Vercel-style preview environments for every pull request. Configure your stack in the Autonoma dashboard, open a PR, get a live URL.
---

Previewkit gives you a fresh, isolated environment for every pull request. You describe your stack once - apps, the services they depend on, and their environment variables - and Previewkit handles the rest: building the containers, provisioning the supporting services, wiring environment variables, and posting the URL back to the PR.

## How it works

Once the Previewkit GitHub App is installed on your repository, every `pull_request` event triggers the pipeline:

1. **Opened / synchronized / reopened** — Previewkit fetches the head commit, builds each app, provisions service recipes (Postgres, Redis, etc.), deploys to a dedicated Kubernetes namespace, and comments the preview URL on the PR.
2. **Closed** — Previewkit deletes the namespace and all resources tied to that PR, then updates the comment.

Each preview gets a unique, opaque URL — a short deterministic hash derived from the service name, PR number, and repo. One PR may expose many apps under one preview — each app gets its own hostname under `preview.autonoma.app`.

A repository can also have a standing **main-branch environment**: a preview deployed from the repository's main branch instead of a PR. Once it exists, every push to that branch redeploys it at the new head automatically, the same way a new commit updates a PR's preview.

## What you configure

You set up your stack in the Autonoma dashboard (the PreviewKit onboarding flow), which saves the configuration for your repository. It declares:

- **Apps** to build and deploy (each becomes a public HTTPS URL)
- **Services** the apps depend on (databases, caches, etc.), picked from a curated catalog of recipes
- **Hooks** that run after deploy (typical use: database migrations)
- **Environment variables**, with templates that resolve service hostnames at deploy time

## Builds work out of the box

Previewkit auto-detects how to build each app:

- If a `Dockerfile` exists in the app's directory (or you specify one explicitly), it builds with [BuildKit](https://github.com/moby/buildkit).
- Otherwise it falls back to [Railpack](https://railpack.com), which detects Node, Python, Go, Ruby, Rust, PHP, Java, and more, and produces a working image without you writing any Dockerfile.

Images are pushed to a private registry and pulled by the preview cluster. You never touch credentials.

## Secrets

Secrets such as API keys and third-party tokens are managed out-of-band via the REST API rather than stored with your stack configuration. They can be owner-scoped (every PR sees them) or PR-scoped (just this PR — useful for testing prod credentials in isolation). Previewkit also injects a few [built-in environment variables](/previewkit/secrets/#built-in-environment-variables) (`AUTONOMA_PREVIEWKIT`, `AUTONOMA_PREVIEWKIT_PR`, `AUTONOMA_PREVIEWKIT_URL`) into every preview so your app can detect it's running in a preview. See [Secrets](/previewkit/secrets/).

## What's next

- [Manage secrets](/previewkit/secrets/) — REST API reference
