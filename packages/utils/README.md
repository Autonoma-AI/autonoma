# @autonoma/utils

Shared utility functions used across the Autonoma monorepo. This is a lightweight, dependency-free package that provides common helpers not specific to any single domain.

## Exports

### `toSlug(name: string): string`

Converts a string into a URL-friendly slug. Lowercases the input, replaces non-alphanumeric characters with dashes, and trims leading/trailing dashes.

```ts
import { toSlug } from "@autonoma/utils";

toSlug("Hello World!"); // "hello-world"
toSlug("  Leading and trailing spaces  "); // "leading-and-trailing-spaces"
toSlug("Special @#$%^&*() characters"); // "special-characters"
```

### `sleep(ms: number): Promise<void>`

Resolve after `ms` milliseconds - the one shared timer for the monorepo, so nobody re-implements `new Promise((resolve) => setTimeout(resolve, ms))`. Exposed at a dedicated subpath (see below), NOT the barrel:

```ts
import { sleep } from "@autonoma/utils/sleep";

await sleep(1_000);
```

### `takeMemorySnapshot(): MemorySnapshot`

Snapshots this process's own memory (`process.memoryUsage()`, converted to MiB) plus, where a cgroup memory file is readable, the whole container's cgroup memory. A gap between `cgroupMb` and `rssMb` points at memory held by a child process (a spawned CLI) rather than the Node heap.

```ts
import { takeMemorySnapshot } from "@autonoma/utils";

takeMemorySnapshot();
// { rssMb: 210.4, heapUsedMb: 88.1, externalMb: 12.3, arrayBuffersMb: 4.1, cgroupMb: 340.7 }
```

`cgroupMb` is `undefined` off Linux/cgroups (local dev, tests) rather than throwing.

`apps/previewkit/src/runner/memory-span.ts` is the reference consumer: it attaches a snapshot to a Sentry span's attributes rather than a log line, so memory shows up next to that span's own duration in Sentry's trace view.

### `SecretCipher`

AES-256-GCM over previewkit secret values held in Postgres. Two things separate it from `EncryptionHelper`:

- **The envelope names its key generation and its binding.** `v2.<keyId>.<base64(iv || ciphertext || tag)>`. A cipher holds exactly one generation, so stored values stay readable across a rotation: resolve the cipher for an envelope's key id rather than expecting one key to open everything. `EncryptionHelper`'s envelope is bare base64 and names nothing, and it stays that way because its format is already written into columns across the schema (Vercel access tokens, scenario signing secrets, preview bypass tokens).
- **The owning row is authenticated.** The `SecretScope` is bound as GCM additional authenticated data, so a ciphertext only decrypts in the exact row it was sealed for. Someone with write access to the database cannot move another tenant's ciphertext into their own row and read it back through the API.

The leading `v` is the envelope version, and it selects what is authenticated - not just which key opens it. `v2` authenticates `kind, appId, key`: the app ROW, so renaming an app costs nothing.

`v1` authenticated `kind, applicationId, appName, key` and is gone. It bound the app's *name*, which is why a rename used to destroy every value an app owned; it stayed readable only for as long as the sweep needed to re-seal the last of it, and a `v1.` envelope is now refused rather than read. The version still leads the envelope so the next change can do the same thing again.

Because `v2` does not authenticate the application, the tenant boundary is not the GCM tag's job any more. `SecretValues` finds a row by resolving the app *within* the caller's application, so another tenant's row is never reachable to begin with.

```ts
import { SecretCipher, readEnvelopeKeyId } from "@autonoma/utils";

const cipher = new SecretCipher(keyId, material);

const sealed = cipher.encrypt(value, { kind: "app", appId, key });
const value = cipher.decrypt(sealed, { kind: "app", appId, key });
```

Scopes are `{ kind: "app", appId, key }` for `PreviewkitSecret` rows. Passing a scope that differs in any field fails the GCM tag check, indistinguishable from tampering. So does handing an envelope to a cipher for a different generation, though that fails with an explicit message instead.

`readEnvelopeKeyId` reads which generation sealed an envelope without needing any key - that is how a caller knows which one to fetch and unwrap.

A `SecretBundle` (`{ kind, applicationId, appName }`) is how a caller *addresses* a set of values - the application plus the app's name, which is what a person knows. It is deliberately not the scope: `scopeFor(appId, key)` builds that, and takes the app row id, because only the row id is authenticated.

```ts
cipher.encrypt(value, scopeFor(appId, "DATABASE_URL"));
```

`SecretValues` is what turns the one into the other, resolving a bundle's app row per operation.

This package deliberately knows nothing about where key material comes from: it takes 32 bytes and a key id. In production those come from `SecretKeys` in `@autonoma/secrets`, which unwraps generations out of the `previewkit_secret_key` table via KMS; tests construct a cipher directly from `randomBytes(32)`.

## Architecture Notes

- **ESM-only** - published as TypeScript source via the `exports` map. No build step required for consumers in the monorepo.
- **Barrel vs. subpath** - most utilities are re-exported from the barrel `src/index.ts` (`import { toSlug } from "@autonoma/utils"`). But the barrel re-exports `encryption.ts`, which uses `node:crypto`/`Buffer`, so importing the barrel pulls node types into the consumer's graph. Utilities that must be usable by **node-type-free packages** (e.g. `@autonoma/agent-core`, which is deliberately dependency-free to bundle lean into the planner CLI) are therefore exposed via their **own subpath** in `exports` (e.g. `"./sleep": "./src/sleep.ts"`) and imported as `@autonoma/utils/sleep`. `sleep.ts` has zero imports, so any package can use it.
- Extends `tsconfig.base.json` with strictest TypeScript settings.

## Adding a New Utility

1. Create a new file in `src/` (e.g., `src/my-helper.ts`) with a single exported function.
2. Decide how to expose it:
    - If it only needs the standard library and node-free consumers might use it, add a dedicated subpath to `exports` in `package.json` (`"./my-helper": "./src/my-helper.ts"`) and import it as `@autonoma/utils/my-helper`. **Do not add it to the barrel** - that would pull `node:crypto` (via `encryption.ts`) into every consumer, breaking node-type-free packages.
    - Otherwise, re-export it from `src/index.ts` (the barrel).
3. Run `pnpm typecheck` to verify.
