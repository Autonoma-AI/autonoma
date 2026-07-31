import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "resolveReturnPath" });

/**
 * Narrows a caller-supplied `?returnTo=` to a path inside our own app, or `undefined`.
 *
 * The value ends up in a `Location` header the browser follows while the visitor's own
 * session cookie is being restored, so anything that could resolve to another origin
 * (`//evil.com`, `https://evil.com`, `\\evil.com`, a `javascript:` URL) must be dropped
 * rather than sanitized - resolving against `appUrl` and comparing origins settles that
 * on the browser's own parsing rules instead of a hand-rolled prefix check.
 */
export function resolveReturnPath(raw: string | undefined, appUrl: string): string | undefined {
    if (raw == null || raw.length === 0) return undefined;

    if (!raw.startsWith("/")) {
        logger.info("Ignoring a returnTo that is not an app-relative path");
        return undefined;
    }

    const resolved = tryResolve(raw, appUrl);
    if (resolved == null) return undefined;

    if (resolved.origin !== new URL(appUrl).origin) {
        logger.info("Ignoring a returnTo that resolves off-origin");
        return undefined;
    }

    return `${resolved.pathname}${resolved.search}`;
}

function tryResolve(raw: string, appUrl: string): URL | undefined {
    try {
        return new URL(raw, appUrl);
    } catch (err) {
        logger.info("Ignoring a returnTo that is not a parseable URL", { extra: { err } });
        return undefined;
    }
}
