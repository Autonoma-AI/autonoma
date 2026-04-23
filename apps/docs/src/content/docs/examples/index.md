---
title: "Examples"
description: "Working examples of the Autonoma Environment Factory across 8 languages and 11 framework combinations."
---

Every example follows the same pattern: install the SDK, configure the handler with your ORM adapter, register a factory for every model that has a dedicated create function in your codebase (service, repository, or similar), and expose a single POST endpoint. Models without a dedicated create function fall back to raw SQL INSERT automatically. The SDK handles schema introspection, FK-ordered entity creation, and scoped teardown.

:::note[Prerequisites]
Read the [Environment Factory Guide](/guides/environment-factory/) first for concepts. These examples are the code.
:::

## Available Examples

All examples live in the [SDK repository](https://github.com/Autonoma-AI/sdk/tree/main/examples). Each one has a README with prerequisites, quick start, project structure, and how it works.

| Language | Framework | ORM / DB | Source |
|----------|-----------|----------|--------|
| [TypeScript](/examples/typescript/) | Express | Prisma | [express-prisma](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/express-prisma) |
| [TypeScript](/examples/typescript/) | Next.js (App Router) | Drizzle | [nextjs-drizzle](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/nextjs-drizzle) |
| [Python](/examples/python/) | FastAPI | SQLAlchemy | [fastapi-sqlalchemy](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/fastapi-sqlalchemy) |
| [Python](/examples/python/) | Flask | SQLAlchemy | [flask-sqlalchemy](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/flask-sqlalchemy) |
| [Python](/examples/python/) | Django | Django ORM | [django](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/django) |
| [Elixir](/examples/elixir/) | Phoenix | Ecto | [phoenix-ecto](https://github.com/Autonoma-AI/sdk/tree/main/examples/elixir/phoenix-ecto) |
| [Java](/examples/java/) | Spring Boot | JDBC | [spring-boot](https://github.com/Autonoma-AI/sdk/tree/main/examples/java/spring-boot) |
| [Ruby](/examples/ruby/) | Rails | ActiveRecord | [rails](https://github.com/Autonoma-AI/sdk/tree/main/examples/ruby/rails) |
| [Rust](/examples/rust/) | Axum | SQLx | [axum-sqlx](https://github.com/Autonoma-AI/sdk/tree/main/examples/rust/axum-sqlx) |
| [Go](/examples/go/) | Gin | database/sql | [gin](https://github.com/Autonoma-AI/sdk/tree/main/examples/go/gin) |
| [PHP](/examples/php/) | Laravel | Eloquent | [laravel](https://github.com/Autonoma-AI/sdk/tree/main/examples/php/laravel) |

## Configuration Reference

Every example configures the same handler fields:

| Field | Description |
|-------|-------------|
| `executor` | Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, Ecto, etc.). Handles schema introspection, SQL generation, and query execution. |
| `scopeField` | The column that scopes all models to a tenant (e.g. `organizationId`). The SDK uses this to isolate test data and ensure teardown only removes records belonging to the test run. |
| `sharedSecret` | Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256. Generate with `openssl rand -hex 32`. |
| `signingSecret` | Private to your server only. Used to sign the refs token that tracks which records were created, so teardown can only delete what was created. Generate with `openssl rand -hex 32`. Must be different from `sharedSecret`. |
| `factories` | Factory per model with a dedicated create function in your codebase (service, repository, or similar helper). Register one for every such model — even thin wrappers — so your tests keep working if you add business logic (password hashing, Stripe sync, cache write) later. Models without a dedicated create function fall back to raw SQL INSERT. |
| `auth` | Called after entity creation during `up`. Returns credentials (cookies, headers, tokens) so Autonoma can make authenticated requests as the test user. |
