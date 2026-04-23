---
title: "PHP"
description: "Autonoma Environment Factory example with Laravel + Eloquent."
---

## Laravel + Eloquent

Uses the auto-discovered service provider from `autonoma/sdk-laravel`. The entire setup is configuration-driven via `config/autonoma.php`.

```php
<?php
// config/autonoma.php
use App\Repositories\OrganizationRepository;
use App\Repositories\UserRepository;
use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Types\FactoryContext;

return [
    // The column that scopes all models to a tenant — used to isolate test data
    'scope_field' => 'organization_id',
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', ''),
    // Private to your server — signs the refs token so teardown only deletes what was created
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),
    'dialect' => 'postgres',
    'path' => 'api/autonoma',

    // Factory per model with a dedicated create function in your codebase.
    // Models without a factory (Project, Task) fall back to raw SQL.
    'factories' => [
        // Organization: slug generation, default settings, external services
        'Organization' => Factory::define(
            function (array $data, FactoryContext $ctx) {
                return (new OrganizationRepository())->create(['name' => $data['name']]);
            },
            function (array $record, FactoryContext $ctx) {
                (new OrganizationRepository())->delete($record['id']);
            }
        ),
        // User: password hashing, email normalization
        'User' => Factory::define(
            function (array $data, FactoryContext $ctx) {
                return (new UserRepository())->create([
                    'email' => $data['email'],
                    'name' => $data['name'],
                    'organization_id' => $data['organization_id'],
                ]);
            }
        ),
    ],

    // Called after `up` — returns credentials so Autonoma can make authenticated requests
    'auth' => function (?array $user, array $context): array {
        return ['headers' => ['Authorization' => 'Bearer test-token']];
    },
];
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/php/laravel)
