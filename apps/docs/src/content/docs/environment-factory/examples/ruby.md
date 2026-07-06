---
title: "Ruby"
description: "Autonoma Environment Factory example with Rails."
---

The Ruby SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `input_fields`. There is no database introspection, no ActiveRecord executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Rails

Uses `AutonomaRails::Handler` mixin in a standard Rails controller. The factories use whatever ActiveRecord models, service objects, or repositories your app already has - the SDK does not need a database connection.

```ruby
# app/controllers/autonoma_controller.rb
require "autonoma"
require "autonoma_rails"

class AutonomaController < ApplicationController
  include AutonomaRails::Handler

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= Autonoma::Types::HandlerConfig.new(
      # The column that scopes all models to a tenant - used to isolate test data
      scope_field: "organization_id",
      # Shared with Autonoma - verifies incoming requests via HMAC-SHA256
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", ""),
      # Private to your server - signs the refs token so teardown only deletes what was created
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", ""),

      # Every model the dashboard can create needs a factory.
      # The factory's input_fields drives both validation and discover.
      factories: {
        "Organization" => Autonoma::Factory.define_factory(
          input_fields: [
            { name: "name", type: "string", required: true }
          ],
          create: ->(data, _ctx) { OrganizationRepository.create(data) },
          teardown: ->(record, _ctx) { OrganizationRepository.delete(record["id"]) }
        ),
        "User" => Autonoma::Factory.define_factory(
          input_fields: [
            { name: "email", type: "string", required: true },
            { name: "name", type: "string", required: true },
            { name: "organization_id", type: "string", required: true }
          ],
          create: ->(data, _ctx) { UserRepository.create(data) }
        ),
      },

      # Called after `up` - returns credentials so Autonoma can make authenticated requests
      auth: ->(_user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/ruby/rails)

---

## What `input_fields` does

The field definitions you pass as `input_fields`:

1. **Drives discover** - the SDK uses the field definitions to describe the model to the dashboard (field names, types, required/optional). No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK checks that all required fields are present and strips unknown keys. Your factory body works on a clean Hash.
3. **Keeps it simple** - no external gems required. Use `"string"`, `"integer"`, `"number"`, `"boolean"`, `"timestamp"`, `"date"`, `"uuid"`, or `"json"` as the type.
