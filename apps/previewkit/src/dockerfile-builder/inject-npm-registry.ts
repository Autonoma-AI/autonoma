import { npmRegistryEnvLines } from "./npm-registry-env";

/** Matches a `FROM` instruction line (Dockerfile keywords are case-insensitive). */
const FROM_LINE = /^\s*FROM\s+/i;

/**
 * Injects the npm/bun registry-mirror `ENV` lines immediately after every
 * `FROM` in a (possibly multi-stage) user-authored Dockerfile, since `ENV`
 * does not carry across stages - each one starts fresh from its base image.
 * Placed right after `FROM`, before any of the customer's own instructions,
 * so it is a default rather than an override: anything the customer's own
 * Dockerfile sets later in that stage (their own `ENV npm_config_registry=`,
 * a private `.npmrc` for scoped packages) is applied afterward and wins.
 *
 * Assumes a `FROM` instruction is a single physical line, which is true of
 * every Dockerfile this platform has seen in practice (a line-continued
 * `FROM` is not valid Dockerfile syntax). Returns the content unchanged when
 * the mirror is disabled.
 */
export function injectNpmRegistryMirror(dockerfileContent: string, npmRegistryMirror: string): string {
    if (npmRegistryMirror === "") return dockerfileContent;

    const envBlock = npmRegistryEnvLines(npmRegistryMirror);
    const lines = dockerfileContent
        .split("\n")
        .flatMap((line) => (FROM_LINE.test(line) ? [line, ...envBlock] : [line]));
    return lines.join("\n");
}
