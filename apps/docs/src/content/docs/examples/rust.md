---
title: "Rust"
description: "Autonoma Environment Factory example with Axum + SQLx."
---

## Axum + SQLx

Uses `create_axum_handler` from `autonoma_sdk::axum` with `SqlxPostgresExecutor`. Factories are registered in a `HashMap<String, FactoryDefinition>`.

```rust
// src/main.rs
use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::factory::define_factory;
use autonoma_sdk::sqlx_adapter::SqlxPostgresExecutor;
use autonoma_sdk::types::{FactoryContext, FactoryRegistry, HandlerConfig};

// Factory per model with a dedicated create function in your codebase.
// Models without a factory (Project, Task) fall back to raw SQL.
let mut factories: FactoryRegistry = HashMap::new();

// Organization: slug generation, default settings, external services
factories.insert(
    "Organization".to_string(),
    define_factory(
        |data, ctx| Box::pin(create_organization(data, ctx)),
        Some(|record: &HashMap<String, Value>, ctx: &FactoryContext<'_>| {
            Box::pin(delete_organization(record, ctx))
        }),
    ),
);

// User: password hashing, email normalization
factories.insert(
    "User".to_string(),
    define_factory(
        |data, ctx| Box::pin(create_user(data, ctx)),
        None, // SDK falls back to SQL DELETE
    ),
);

let config = HandlerConfig {
    // Connects the SDK to your database through SQLx
    executor: Box::new(SqlxPostgresExecutor::new(pool)),
    // The column that scopes all models to a tenant — used to isolate test data
    scope_field: "organization_id".to_string(),
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret,
    // Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret,
    factories: Some(factories),
    // Called after `up` — returns credentials so Autonoma can make authenticated requests
    // auth: ...
};

let app = Router::new()
    .route("/api/autonoma", post(create_axum_handler(config)));
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/rust/axum-sqlx)
