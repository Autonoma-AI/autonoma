---
title: "Go"
description: "Autonoma Environment Factory example with Gin + database/sql."
---

## Gin + database/sql

Uses `autonoma.GinHandler` with `autonoma.NewSQLExecutor`. Factories are registered in an `autonoma.FactoryRegistry` map.

```go
// main.go
import "github.com/autonoma-ai/sdk-go/autonoma"

config := &autonoma.HandlerConfig{
    // Connects the SDK to your database through database/sql
    Executor:      autonoma.NewSQLExecutor(db),
    // The column that scopes all models to a tenant — used to isolate test data
    ScopeField:    "organization_id",
    Dialect:       "postgres",
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    SharedSecret:  os.Getenv("AUTONOMA_SHARED_SECRET"),
    // Private to your server — signs the refs token so teardown only deletes what was created
    SigningSecret:  os.Getenv("AUTONOMA_SIGNING_SECRET"),

    // Factory per model with a dedicated create function in your codebase.
    // Models without a factory (Project, Task) fall back to raw SQL.
    Factories: autonoma.FactoryRegistry{
        // Organization: slug generation, default settings, external services
        "Organization": autonoma.FactoryDefinition{
            Create: func(data map[string]any, ctx autonoma.FactoryContext) (map[string]any, error) {
                return createOrganization(db, data)
            },
            Teardown: func(record map[string]any, ctx autonoma.FactoryContext) error {
                return deleteOrganization(db, record["id"].(string))
            },
        },
        // User: password hashing, email normalization
        "User": autonoma.FactoryDefinition{
            Create: func(data map[string]any, ctx autonoma.FactoryContext) (map[string]any, error) {
                return createUser(db, data)
            },
        },
    },

    // Called after `up` — returns credentials so Autonoma can make authenticated requests
    Auth: func(user map[string]any, ctx autonoma.AuthContext) (*autonoma.AuthResult, error) {
        return &autonoma.AuthResult{
            Extra: map[string]any{"headers": map[string]any{"Authorization": "Bearer test-token"}},
        }, nil
    },
}

r := gin.Default()
r.POST("/api/autonoma", autonoma.GinHandler(config))
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/go/gin)
