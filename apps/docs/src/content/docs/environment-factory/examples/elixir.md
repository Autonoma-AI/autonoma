---
title: "Elixir"
description: "Autonoma Environment Factory example with Phoenix."
---

The Elixir SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `input_fields`. There is no database introspection, no Ecto executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Phoenix

Uses `Autonoma.Plug.Handler` as a Plug mounted via Phoenix's `forward` macro. The factories use whatever Ecto Repo or service module your app already has - the SDK does not need a database connection.

```elixir
# lib/autonoma_example/router.ex
defmodule AutonomaExample.Router do
  use Phoenix.Router

  alias AutonomaExample.Repositories

  @autonoma_config %{
    # The column that scopes all models to a tenant - used to isolate test data
    scope_field: "organization_id",
    # Shared with Autonoma - verifies incoming requests via HMAC-SHA256
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "",
    # Private to your server - signs the refs token so teardown only deletes what was created
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "",

    # Every model the dashboard can create needs a factory.
    # The factory's input_fields drives both validation and discover.
    factories: %{
      "Organization" => Autonoma.Factory.define_factory(%{
        input_fields: [
          %{name: "name", type: "string", required: true}
        ],
        create: fn data, _ctx -> Repositories.Organization.create(data) end,
        teardown: fn record, _ctx -> Repositories.Organization.delete(record["id"]) end
      }),
      "User" => Autonoma.Factory.define_factory(%{
        input_fields: [
          %{name: "email", type: "string", required: true},
          %{name: "name", type: "string", required: true},
          %{name: "organization_id", type: "string", required: true}
        ],
        create: fn data, _ctx -> Repositories.User.create(data) end
      })
    },

    # Called after `up` - returns credentials so Autonoma can make authenticated requests
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/elixir/phoenix)

---

## What `input_fields` does

The field list you pass as `input_fields`:

1. **Drives discover** - the SDK uses the field definitions to describe the model to the dashboard (field names, types, required/optional). No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK checks that all required fields are present and strips unknown keys. Your factory body works on a clean map.
3. **Keeps it simple** - no external dependencies required. Use `"string"`, `"integer"`, `"number"`, `"boolean"`, `"timestamp"`, `"date"`, `"uuid"`, or `"json"` as the type.
