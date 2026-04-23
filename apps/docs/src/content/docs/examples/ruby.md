---
title: "Ruby"
description: "Autonoma Environment Factory example with Rails + ActiveRecord."
---

## Rails + ActiveRecord

Uses the `AutonomaRails::Handler` mixin with `AutonomaActiveRecord.create_config`. The handler is a standard Rails controller action.

```ruby
# app/controllers/autonoma_controller.rb
require "autonoma_active_record"
require "autonoma_rails"

class AutonomaController < ApplicationController
  include AutonomaRails::Handler

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= AutonomaActiveRecord.create_config(
      # The column that scopes all models to a tenant — used to isolate test data
      scope_field: "organization_id",
      # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET", ""),
      # Private to your server — signs the refs token so teardown only deletes what was created
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET", ""),

      # Factory per model with a dedicated create function in your codebase.
      # Models without a factory (Project, Task) fall back to raw SQL.
      factories: {
        # Organization: slug generation, default settings, external services
        "Organization" => Autonoma::Factory.define_factory(
          create: ->(data, _ctx) { OrganizationRepository.create(data) },
          teardown: ->(record, _ctx) { OrganizationRepository.delete(record["id"]) }
        ),
        # User: password hashing, email normalization
        "User" => Autonoma::Factory.define_factory(
          create: ->(data, _ctx) { UserRepository.create(data) }
        ),
      },

      # Called after `up` — returns credentials so Autonoma can make authenticated requests
      auth: ->(_user, _context) {
        { "headers" => { "Authorization" => "Bearer test-token" } }
      }
    )
  end
end
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/ruby/rails)
