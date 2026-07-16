---
title: "Examples"
description: "Working Environment Factory endpoints across 8 languages and 12 framework combinations - copy one for your stack."
---

Every example follows the same shape: install the SDK, configure the handler, register a factory for each model, and expose a single POST endpoint. Each factory carries an input schema (Pydantic in Python, Zod in TypeScript, and so on) so the SDK can describe the model to the dashboard and validate the create payload before invoking your code. There is no SQL introspection and no SQL fallback.

:::note[New here?]
Read the [Environment Factory overview](/environment-factory/) for the concepts and the [Setup guide](/environment-factory/setup/) for the step-by-step. These examples are the finished code.
:::

## Available examples

All examples live in the [SDK repository](https://github.com/Autonoma-AI/sdk/tree/main/examples). Each one ships with a README covering prerequisites, quick start, project structure, and how it works.

| Language | Framework | Schema lib | Source |
|----------|-----------|------------|--------|
| [TypeScript](/environment-factory/examples/typescript/) | Express | Zod | [express](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/express) |
| [TypeScript](/environment-factory/examples/typescript/) | Next.js (App Router) | Zod | [nextjs](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/nextjs) |
| [TypeScript](/environment-factory/examples/typescript/) | Hono | Zod | [hono](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/hono) |
| [Python](/environment-factory/examples/python/) | FastAPI | Pydantic | [fastapi](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/fastapi) |
| [Python](/environment-factory/examples/python/) | Flask | Pydantic | [flask](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/flask) |
| [Python](/environment-factory/examples/python/) | Django | Pydantic | [django](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/django) |
| [Elixir](/environment-factory/examples/elixir/) | Phoenix | Ecto schemas | [phoenix](https://github.com/Autonoma-AI/sdk/tree/main/examples/elixir/phoenix) |
| [Java](/environment-factory/examples/java/) | Spring Boot | Bean Validation | [spring-boot](https://github.com/Autonoma-AI/sdk/tree/main/examples/java/spring-boot) |
| [Ruby](/environment-factory/examples/ruby/) | Rails | dry-validation | [rails](https://github.com/Autonoma-AI/sdk/tree/main/examples/ruby/rails) |
| [Rust](/environment-factory/examples/rust/) | Axum | serde + validator | [axum](https://github.com/Autonoma-AI/sdk/tree/main/examples/rust/axum) |
| [Go](/environment-factory/examples/go/) | Gin | go-playground/validator | [gin](https://github.com/Autonoma-AI/sdk/tree/main/examples/go/gin) |
| [PHP](/environment-factory/examples/php/) | Laravel | Symfony Validator | [laravel](https://github.com/Autonoma-AI/sdk/tree/main/examples/php/laravel) |

## Configuration reference

Every example configures the same handler fields:

| Field | Description |
|-------|-------------|
| `scopeField` | The column that scopes all models to a tenant (e.g. `organizationId`). Declared in `discover` so the dashboard knows how to isolate test data. |
| `sharedSecret` | Shared between your server and Autonoma. Verifies incoming requests via HMAC-SHA256. Generate with `openssl rand -hex 32`. |
| `signingSecret` | Private to your server. Signs the refs token so teardown can only delete what was created. Generate with `openssl rand -hex 32`, and make it different from `sharedSecret`. |
| `factories` | One factory per model. Each declares an `inputSchema` / `input_model` plus a `create` that calls your real service, and an optional `teardown`. |
| `auth` | Called during `up` with the created user. Returns credentials (cookies, headers, or credentials) so Autonoma can act as the test user. |

For what each field does in depth, see [Factories & the create payload](/environment-factory/factories/), [Authentication](/environment-factory/authentication/), and [Security](/environment-factory/security/).
