---
title: "Rust"
description: "Autonoma Environment Factory example with Axum."
---

The Rust SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `input_fields`. There is no database introspection, no SQLx executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Axum

Uses `create_axum_handler` from `autonoma_sdk::axum`. Factories are registered in a `HashMap<String, FactoryDefinition>`. The factories use whatever SQLx pool, Diesel connection, or service layer your app already has - the SDK does not need a database connection.

```rust
// src/main.rs
use autonoma_sdk::axum::create_axum_handler;
use autonoma_sdk::factory::{define_factory, define_factory_create_only};
use autonoma_sdk::types::{FactoryContext, FactoryRegistry, FieldDef, HandlerConfig};
use std::collections::HashMap;

let mut factories: FactoryRegistry = HashMap::new();

factories.insert(
    "Organization".to_string(),
    define_factory(
        vec![FieldDef { name: "name".into(), field_type: "string".into(), required: true }],
        |data, ctx| Box::pin(create_organization(data, ctx)),
        Some(|record, ctx| Box::pin(delete_organization(record, ctx))),
        None,
    ),
);

factories.insert(
    "User".to_string(),
    define_factory_create_only(
        vec![
            FieldDef { name: "email".into(), field_type: "string".into(), required: true },
            FieldDef { name: "name".into(), field_type: "string".into(), required: true },
            FieldDef { name: "organization_id".into(), field_type: "string".into(), required: true },
        ],
        |data, ctx| Box::pin(create_user(data, ctx)),
    ),
);

let config = HandlerConfig {
    // The column that scopes all models to a tenant - used to isolate test data
    scope_field: "organization_id".to_string(),
    // Shared with Autonoma - verifies incoming requests via HMAC-SHA256
    shared_secret,
    // Private to your server - signs the refs token so teardown only deletes what was created
    signing_secret,
    factories,
    // Deprecated no-op, but the struct still requires the field
    allow_production: false,
    // Called after `up` - returns credentials so Autonoma can make authenticated requests
    auth: Box::new(|_user, _ctx| {
        Box::pin(async move {
            let mut out: HashMap<String, serde_json::Value> = HashMap::new();
            out.insert(
                "headers".into(),
                serde_json::json!({ "Authorization": "Bearer test-token" }),
            );
            out
        })
    }),
    sdk: None,
    before_down: None,
    after_up: None,
};

let app = Router::new()
    .route("/api/autonoma", post(create_axum_handler(config)));
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/rust/axum)

---

## What `input_fields` does

The `Vec<FieldDef>` you pass as the first argument to `define_factory`:

1. **Drives discover** - the SDK uses the field definitions to describe the model to the dashboard (field names, types, required/optional). No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK checks that all required fields are present in the `serde_json::Map`. Your factory body works on a validated map.
3. **Keeps it simple** - no external dependencies required beyond `serde_json`. Use `"string"`, `"integer"`, `"number"`, `"boolean"`, `"timestamp"`, `"date"`, `"uuid"`, or `"json"` as the type.
