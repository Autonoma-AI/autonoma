---
title: "Go"
description: "Autonoma Environment Factory example with Gin."
---

The Go SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `InputStruct` (a Go struct type). There is no database introspection, no SQL executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Gin

Uses `autonoma.GinHandler` with factories registered in an `autonoma.FactoryRegistry` map. The factories use whatever `*sql.DB`, GORM, or service layer your app already has - the SDK does not need a database connection.

```go
// main.go
import (
    "os"
    "github.com/autonoma-ai/sdk-go/autonoma"
    "github.com/gin-gonic/gin"
)

type OrganizationInput struct {
    Name string `json:"name"`
}

type UserInput struct {
    Email          string `json:"email"`
    Name           string `json:"name"`
    OrganizationID string `json:"organization_id"`
}

config := &autonoma.HandlerConfig{
    // The column that scopes all models to a tenant - used to isolate test data
    ScopeField:   "organization_id",
    // Shared with Autonoma - verifies incoming requests via HMAC-SHA256
    SharedSecret:  os.Getenv("AUTONOMA_SHARED_SECRET"),
    // Private to your server - signs the refs token so teardown only deletes what was created
    SigningSecret:  os.Getenv("AUTONOMA_SIGNING_SECRET"),

    // Every model the dashboard can create needs a factory.
    // The factory's InputStruct drives both validation and discover.
    Factories: autonoma.FactoryRegistry{
        "Organization": autonoma.DefineFactory(autonoma.FactoryOpts{
            InputStruct: reflect.TypeOf(OrganizationInput{}),
            Create: func(data any, ctx autonoma.FactoryContext) (map[string]any, error) {
                input := data.(*OrganizationInput)
                return createOrganization(db, input)
            },
            Teardown: func(record map[string]any, ctx autonoma.FactoryContext) error {
                return deleteOrganization(db, record["id"].(string))
            },
        }),
        "User": autonoma.DefineFactory(autonoma.FactoryOpts{
            InputStruct: reflect.TypeOf(UserInput{}),
            Create: func(data any, ctx autonoma.FactoryContext) (map[string]any, error) {
                input := data.(*UserInput)
                return createUser(db, input)
            },
        }),
    },

    // Called after `up` - returns credentials so Autonoma can make authenticated requests
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

---

## What `InputStruct` does

The Go struct type you pass as `InputStruct`:

1. **Drives discover** - the SDK uses `reflect` to walk the struct's fields and `json` tags to describe the model to the dashboard (field names, types, required/optional). No database introspection runs.
2. **Validates the create payload** - before invoking your `Create` function, the SDK uses `json.Unmarshal` into a new instance of the struct. Type mismatches and missing required fields fail validation. Your factory body receives a typed pointer to the struct.
3. **Uses standard Go conventions** - field names come from `json` struct tags; Go types map to SDK types automatically (`string`→"string", `int`→"integer", `float64`→"number", `bool`→"boolean", `time.Time`→"timestamp", `uuid.UUID`→"uuid").
