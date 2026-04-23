---
title: "Elixir"
description: "Autonoma Environment Factory example with Phoenix + Ecto."
---

## Phoenix + Ecto

Uses `Autonoma.Plug.Handler` with `ecto_executor` from `Autonoma.Ecto.Executor`. The handler is mounted via Phoenix's `forward` macro.

```elixir
# lib/autonoma_example/router.ex
defmodule AutonomaExample.Router do
  use Phoenix.Router

  alias AutonomaExample.Repositories

  @executor Autonoma.Ecto.Executor.ecto_executor(AutonomaExample.Repo)

  @autonoma_config %{
    # Connects the SDK to your database through Ecto
    executor: @executor,
    # The column that scopes all models to a tenant — used to isolate test data
    scope_field: "organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret: System.get_env("AUTONOMA_SHARED_SECRET") || "",
    # Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET") || "",

    # Factory per model with a dedicated create function in your codebase.
    # Models without a factory (Project, Task) fall back to raw SQL.
    factories: %{
      # Organization: slug generation, default settings, external services
      "Organization" => Autonoma.Factory.define_factory(%{
        create: fn data, _ctx -> Repositories.Organization.create(data) end,
        teardown: fn record, _ctx -> Repositories.Organization.delete(record["id"]) end
      }),
      # User: password hashing, email normalization
      "User" => Autonoma.Factory.define_factory(%{
        create: fn data, _ctx -> Repositories.User.create(data) end
      })
    },

    # Called after `up` — returns credentials so Autonoma can make authenticated requests
    auth: fn _user, _context ->
      %{"headers" => %{"Authorization" => "Bearer test-token"}}
    end
  }

  forward "/api/autonoma", Autonoma.Plug.Handler, @autonoma_config
end
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/elixir/phoenix-ecto)
