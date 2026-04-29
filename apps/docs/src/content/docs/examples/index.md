---
title: "Examples"
description: "Working examples of the Autonoma Environment Factory across 8 languages and 11 framework combinations."
---

Every example follows the same pattern: install the SDK, configure the handler, register a factory for every model the dashboard can create, and expose a single POST endpoint. Each factory carries an input schema (Pydantic in Python, Zod in TypeScript, Ecto/serde/etc. elsewhere) so the SDK can describe the model to the dashboard and validate the create payload before invoking your code. There is no SQL introspection and no SQL fallback.

:::note[Prerequisites]
Read the [Environment Factory Guide](/guides/environment-factory/) first for concepts. These examples are the code.
:::

## Available Examples

All examples live in the [SDK repository](https://github.com/Autonoma-AI/sdk/tree/main/examples). Each one has a README with prerequisites, quick start, project structure, and how it works.

| Language | Framework | Schema lib | Source |
|----------|-----------|------------|--------|
| [TypeScript](/examples/typescript/) | Express | Zod | [express](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/express) |
| [TypeScript](/examples/typescript/) | Next.js (App Router) | Zod | [nextjs](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/nextjs) |
| [TypeScript](/examples/typescript/) | Hono | Zod | [hono](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/hono) |
| [Python](/examples/python/) | FastAPI | Pydantic | [fastapi](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/fastapi) |
| [Python](/examples/python/) | Flask | Pydantic | [flask](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/flask) |
| [Python](/examples/python/) | Django | Pydantic | [django](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/django) |
| [Elixir](/examples/elixir/) | Phoenix | Ecto schemas | [phoenix](https://github.com/Autonoma-AI/sdk/tree/main/examples/elixir/phoenix) |
| [Java](/examples/java/) | Spring Boot | Bean Validation | [spring-boot](https://github.com/Autonoma-AI/sdk/tree/main/examples/java/spring-boot) |
| [Ruby](/examples/ruby/) | Rails | dry-validation | [rails](https://github.com/Autonoma-AI/sdk/tree/main/examples/ruby/rails) |
| [Rust](/examples/rust/) | Axum | serde + validator | [axum](https://github.com/Autonoma-AI/sdk/tree/main/examples/rust/axum) |
| [Go](/examples/go/) | Gin | go-playground/validator | [gin](https://github.com/Autonoma-AI/sdk/tree/main/examples/go/gin) |
| [PHP](/examples/php/) | Laravel | Symfony Validator | [laravel](https://github.com/Autonoma-AI/sdk/tree/main/examples/php/laravel) |

## Configuration Reference

Every example configures the same handler fields:

| Field | Description |
|-------|-------------|
| `scopeField` | The column that scopes all models to a tenant (e.g. `organizationId`). The SDK uses this to isolate test data and ensure teardown only removes records belonging to the test run. |
| `sharedSecret` | Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256. Generate with `openssl rand -hex 32`. |
| `signingSecret` | Private to your server only. Used to sign the refs token that tracks which records were created, so teardown can only delete what was created. Generate with `openssl rand -hex 32`. Must be different from `sharedSecret`. |
| `factories` | One factory per model the dashboard can create. Each factory declares an `input_model` / `inputSchema` (Pydantic, Zod, etc.) plus a `create` function that calls your real service/repository, and an optional `teardown`. The SDK introspects the schema to drive `discover` and validates payloads through it before invoking `create`. |
| `auth` | Called after entity creation during `up`. Returns credentials (cookies, headers, tokens) so Autonoma can make authenticated requests as the test user. |
