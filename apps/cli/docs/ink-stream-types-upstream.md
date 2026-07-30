# Upstream task: let Ink accept a capture stream without a type assertion

**Repo to change:** https://github.com/vadimdemedes/ink (genuine upstream, not a fork)
**Version we are on:** `ink@7.1.1`
**Why this exists:** we currently carry a local patch, `patches/ink@7.1.1.patch`, that does exactly
what is described below. The goal is to land the same change upstream so the patch can be deleted.

This is a **types-only** change. No runtime behaviour changes, so it cannot break anyone's app.

---

## The problem

`render()` types its stream options as full Node tty streams:

```ts
// src/render.ts
export type RenderOptions = {
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    stderr?: NodeJS.WriteStream;
    // ...
};

const render = (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Instance;
```

`NodeJS.WriteStream` is `tty.WriteStream`, which extends `net.Socket`. That is roughly 80 members:
`clearLine`, `cursorTo`, `moveCursor`, `connect`, `remoteAddress`, and so on.

At runtime Ink touches almost none of them. Rendering to an in-memory capture stream is a
**supported and documented use** - it is exactly what `debug: true` is for, and what
`ink-testing-library` does - but the types make it impossible to express. Every consumer doing it
today needs an assertion:

```ts
render(tree, { stdout: sink as unknown as NodeJS.WriteStream });
```

`ink-testing-library` does this internally. So does any project with its own headless renderer
(ours does, which is why we wrote the patch). Codebases that ban `as unknown as` cannot use a
first-class Ink feature without an explicit lint exception.

## What Ink actually uses

Enumerated from `ink@7.1.1`'s compiled output:

```
$ grep -oE "stdout\.[a-zA-Z]+" build/*.js build/components/*.js build/hooks/*.js | ...
columns  destroyed  isTTY  off  on  writable  writableEnded  writableLength  write

$ grep -oE "stdin\.[a-zA-Z]+"  build/*.js build/components/*.js build/hooks/*.js | ...
addListener  isTTY  on  read  ref  removeListener  setEncoding  setRawMode  unref  unshift
```

Note that everything in `getWritableStreamState` is already written defensively, which is good
evidence the narrow surface is intentional:

```js
// build/ink.js
const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
const hasWritableState = stdout._writableState !== undefined || stdout.writableLength !== undefined;
```

Undefined values are handled, so those members belong in the type as optional, not required.

## The change

Introduce two structural types and use them for the three options. Keep the names exported so
consumers can type their own sinks against them.

```ts
/**
Minimal shape Ink needs from an output stream.

Typed structurally rather than as `NodeJS.WriteStream` so a capture stream (a headless render, a
test harness) is accepted without an assertion. Everything beyond `write` is optional because Ink
guards for its absence at runtime.
*/
export type InkOutputStream = {
    write(data: string, ...rest: any[]): unknown;
    columns?: number;
    rows?: number;
    isTTY?: boolean;
    destroyed?: boolean;
    writable?: boolean;
    writableEnded?: boolean;
    writableLength?: number;
    on?(event: any, listener: any): unknown;
    off?(event: any, listener: any): unknown;
};

/** Minimal shape Ink needs from an input stream. See `InkOutputStream`. */
export type InkInputStream = {
    on(event: any, listener: any): unknown;
    read(...args: any[]): unknown;
    isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
    setEncoding?(...args: any[]): unknown;
    unshift?(...args: any[]): unknown;
    addListener?(event: any, listener: any): unknown;
    removeListener?(event: any, listener: any): unknown;
    ref?(): unknown;
    unref?(): unknown;
};
```

Then:

```ts
export type RenderOptions = {
    stdout?: InkOutputStream;
    stdin?: InkInputStream;
    stderr?: InkOutputStream;
    // ...
};

const render = (node: ReactNode, options?: InkOutputStream | RenderOptions) => Instance;
```

### Notes for whoever implements it

- **Use method shorthand, not arrow properties.** `write(data: string): unknown` is bivariant in its
  parameters; `write: (data: string) => unknown` is contravariant under `strictFunctionTypes` and
  will reject `process.stdout`, whose `setEncoding` takes `BufferEncoding` rather than `string`.
  This is the single easiest way to get the change subtly wrong.
- **`process.stdout` and `process.stdin` must still be assignable.** That is the primary use and the
  default value. Add a type-level test asserting both.
- Internal declarations still referencing the Node types (`Ink`'s own `Options`, `instances.ts`'s
  `WeakMap<NodeJS.WriteStream, Ink>`, `getWindowSize`) can stay as they are for a minimal diff, or
  be migrated in the same PR - the public surface is what matters. Our patch changed only
  `render.d.ts` and that was sufficient.
- Ink is authored in TypeScript, so make the change in `src/render.ts` (we patched the built
  `.d.ts` because that is all a `pnpm patch` can reach).

### Suggested PR framing

Title: `fix(types): accept capture streams in RenderOptions without an assertion`

Body should make these points:

1. It is types-only; no runtime change, no behaviour change, not a breaking change.
2. `debug: true` renders to a stream and is a documented feature, but the types force an assertion
   to use it with anything other than a real tty.
3. `ink-testing-library`, Ink's own companion package, needs `as unknown as` today. That is
   evidence the type is wrong rather than that the usage is.
4. The new types are derived from what Ink actually reads (include the grep output above).
5. Mention that `getWritableStreamState` already handles undefined for those members.

## Definition of done

- [ ] PR open against `vadimdemedes/ink` with the change in `src/render.ts`
- [ ] Type-level test that `process.stdout` / `process.stdin` remain assignable
- [ ] Type-level test that a `{ write, columns, rows, isTTY }` object is accepted
- [ ] Link the PR back to Autonoma PR #1871

Once it lands and we bump Ink: delete `patches/ink@7.1.1.patch`, drop the `patchedDependencies`
entry from `pnpm-workspace.yaml`, and remove the patch note from the doc comment in
`apps/cli/src/replay/headless-renderer.tsx`. Nothing else should need to change - if the upstream
types match the patch, `HeadlessRenderer` keeps compiling untouched.
