# @autonoma/utils

Shared utility functions used across the Autonoma monorepo. This is a lightweight, dependency-free package that provides common helpers not specific to any single domain.

## Exports

### `toSlug(name: string): string`

Converts a string into a URL-friendly slug. Lowercases the input, replaces non-alphanumeric characters with dashes, and trims leading/trailing dashes.

```ts
import { toSlug } from "@autonoma/utils";

toSlug("Hello World!");                      // "hello-world"
toSlug("  Leading and trailing spaces  ");   // "leading-and-trailing-spaces"
toSlug("Special @#$%^&*() characters");      // "special-characters"
```

### `sleep(ms: number): Promise<void>`

Resolve after `ms` milliseconds - the one shared timer for the monorepo, so nobody re-implements `new Promise((resolve) => setTimeout(resolve, ms))`. Exposed at a dedicated subpath (see below), NOT the barrel:

```ts
import { sleep } from "@autonoma/utils/sleep";

await sleep(1_000);
```

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
