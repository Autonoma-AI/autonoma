---
title: "PHP"
description: "Autonoma Environment Factory example with Laravel."
---

The PHP SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `inputFields`. There is no database introspection, no Eloquent executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Laravel

Uses the auto-discovered service provider from `autonoma-ai/sdk`. The entire setup is configuration-driven via `config/autonoma.php`. The factories use whatever Eloquent models, repositories, or service classes your app already has - the SDK does not need a database connection.

```php
<?php
// config/autonoma.php
use App\Repositories\OrganizationRepository;
use App\Repositories\UserRepository;
use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Types\FieldInfo;
use Autonoma\Sdk\Types\FactoryContext;

return [
    // The column that scopes all models to a tenant - used to isolate test data
    'scope_field' => 'organization_id',
    // Shared with Autonoma - verifies incoming requests via HMAC-SHA256
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', ''),
    // Private to your server - signs the refs token so teardown only deletes what was created
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),
    'path' => 'api/autonoma',

    // Every model the dashboard can create needs a factory.
    // The factory's inputFields drives both validation and discover.
    'factories' => [
        'Organization' => Factory::define(
            inputFields: [
                new FieldInfo('name', 'string', true),
            ],
            create: function (array $data, FactoryContext $ctx) {
                return (new OrganizationRepository())->create(['name' => $data['name']]);
            },
            teardown: function (array $record, FactoryContext $ctx) {
                (new OrganizationRepository())->delete($record['id']);
            }
        ),
        'User' => Factory::define(
            inputFields: [
                new FieldInfo('email', 'string', true),
                new FieldInfo('name', 'string', true),
                new FieldInfo('organization_id', 'string', true),
            ],
            create: function (array $data, FactoryContext $ctx) {
                return (new UserRepository())->create([
                    'email' => $data['email'],
                    'name' => $data['name'],
                    'organization_id' => $data['organization_id'],
                ]);
            }
        ),
    ],

    // Called after `up` - returns credentials so Autonoma can make authenticated requests
    'auth' => function (?array $user, array $context): array {
        return ['headers' => ['Authorization' => 'Bearer test-token']];
    },
];
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/php/laravel)

---

## What `inputFields` does

The `FieldInfo` array you pass as `inputFields`:

1. **Drives discover** - the SDK uses the field definitions to describe the model to the dashboard (field names, types, required/optional). No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK checks that all required fields are present and strips unknown keys. Your factory body works on a clean associative array.
3. **Keeps it simple** - no external dependencies required. Use `'string'`, `'integer'`, `'number'`, `'boolean'`, `'timestamp'`, `'date'`, `'uuid'`, or `'json'` as the type.
