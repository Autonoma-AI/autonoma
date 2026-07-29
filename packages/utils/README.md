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

### `SecretCipher`

AES-256-GCM over previewkit secret values held in Postgres. Two things separate it from `EncryptionHelper`:

- **The envelope names its key generation.** `v1.<keyId>.<base64(iv || ciphertext || tag)>`. A cipher holds exactly one generation, so stored values stay readable across a rotation: resolve the cipher for an envelope's key id rather than expecting one key to open everything. `EncryptionHelper`'s envelope is bare base64 and names nothing, and it stays that way because its format is already written into columns across the schema (Vercel access tokens, scenario signing secrets, preview bypass tokens).
- **The owning row is authenticated.** The `SecretScope` is bound as GCM additional authenticated data, so a ciphertext only decrypts in the exact row it was sealed for. Someone with write access to the database cannot move another tenant's ciphertext into their own row and read it back through the API.

```ts
import { SecretCipher, readEnvelopeKeyId } from "@autonoma/utils";

const cipher = new SecretCipher(keyId, material);

const sealed = cipher.encrypt(value, { kind: "app", applicationId, appName, key });
const value = cipher.decrypt(sealed, { kind: "app", applicationId, appName, key });
```

Scopes are `{ kind: "app", applicationId, appName, key }` for `PreviewkitSecret` rows and `{ kind: "org", organizationId, name, key }` for `PreviewkitOrgSecret` rows. Passing a scope that differs in any field fails the GCM tag check, indistinguishable from tampering. So does handing an envelope to a cipher for a different generation, though that fails with an explicit message instead.

`readEnvelopeKeyId` reads which generation sealed an envelope without needing any key - that is how a caller knows which one to fetch and unwrap.

Callers hold a `SecretBundle` (a scope without the key) and derive each value's scope with `scopeIn(bundle, key)`, so the authenticated data is assembled in one place instead of being spelled out per call site where a field could quietly be missed:

```ts
const bundle: SecretBundle = { kind: "app", applicationId, appName };

cipher.encrypt(value, scopeIn(bundle, "DATABASE_URL"));
```

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
