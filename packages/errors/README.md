# @autonoma/errors

Error handling utilities for wrapping and normalizing unexpected (external) errors across the Autonoma platform.

## What it does

This package provides a structured way to catch, wrap, and log errors from external or unclassified sources. The goal is that all unexpected errors flow through `external` / `externalSync`, giving a single place to normalize non-Error values, attach logging, and apply custom wrappers. Over time, external errors should be reclassified into more specific error types.

## Exports

| Export | Type | Description |
|---|---|---|
| `ExternalError` | Class | Generic wrapper for unexpected errors. Sets the original error as `cause`. |
| `ExternalErrorConfig` | Type | Options for `external` / `externalSync` - suppressing logs, custom messages, and error wrappers. |
| `external` | Function | Wraps an async function, catching and normalizing any thrown error. |
| `externalSync` | Function | Wraps a sync function, catching and normalizing any thrown error. |
| `causeMessage` | Function | The message of a thrown value, stringifying non-`Error` throws instead of dropping them. Prefer it over an inline `err instanceof Error ? err.message : String(err)`. |

## Usage

### Basic - catch and re-throw with logging

```ts
import { external, externalSync } from "@autonoma/errors";

// Async
const result = await external(() => fetch("https://api.example.com/data"), {
  errorMessage: "Failed to fetch data from external API",
});

// Sync
const parsed = externalSync(() => JSON.parse(rawInput), {
  errorMessage: "Failed to parse input",
});
```

### Custom error wrapper

Wrap the caught error in a domain-specific error type:

```ts
import { external } from "@autonoma/errors";
import { ThirdPartyError } from "./errors";

const user = await external(() => stripeClient.customers.retrieve(id), {
  errorMessage: "Stripe customer lookup failed",
  wrapper: (error) => new ThirdPartyError("stripe", error),
});
```

### Suppress logging

When the caller handles logging itself:

```ts
const data = await external(() => riskyOperation(), {
  suppressLogging: true,
});
```

## ExternalErrorConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `suppressLogging` | `boolean` | `false` | Skip logging when the error is caught. |
| `errorMessage` | `string \| null` | `null` | Message passed to the logger. If `null`, nothing is logged (even when `suppressLogging` is `false`). |
| `wrapper` | `(error: Error) => Error` | Identity | Transform the error before re-throwing. Useful for wrapping in domain-specific error classes. |

## Architecture notes

- Non-Error thrown values (strings, numbers, etc.) are automatically wrapped in a proper `Error` instance.
- Logging uses `@autonoma/logger` - the root logger instance.
- The `ExternalError` class preserves the original error via the standard `cause` property.
- This package is ESM-only (`"type": "module"`).
