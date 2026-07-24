import { logger as rootLogger } from "../logger";

/** How long to wait for the mirror's health endpoint before treating it as down. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Decides whether the npm registry mirror should be used for this build.
 *
 * The mirror is injected as `npm_config_registry` into every generated and
 * user-authored Dockerfile, which makes it a hard dependency of every Node
 * install: if it is unreachable, `npm ci` / `pnpm install` / `yarn install` /
 * `bun install` fail and the build dies with an opaque `buildctl exited with
 * code 1`. That turns one unhealthy pod into a total build outage for every
 * customer, so probe it first and fall back to the public registry when it does
 * not answer - a slower build beats a failed one.
 *
 * Returns the mirror when it is healthy, or `""` (the existing "no mirror"
 * value both injection paths already understand) when it is not. Never throws:
 * any failure degrades to the public registry.
 */
export async function resolveNpmRegistryMirror(configuredMirror: string): Promise<string> {
    const logger = rootLogger.child({ name: "resolveNpmRegistryMirror" });
    if (configuredMirror === "") return "";

    // Inside the try: a malformed mirror (a missing scheme is the easy typo)
    // makes `new URL` throw, and this resolver is awaited during service
    // construction - before the runner's own try - so an escaping throw would
    // crash the whole build at startup rather than degrading it.
    let probeUrl = configuredMirror;
    try {
        // Verdaccio (and npm registries generally) expose a liveness endpoint here.
        probeUrl = new URL("/-/ping", configuredMirror).toString();
        const response = await fetch(probeUrl, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
            logger.warn("npm registry mirror is unhealthy; falling back to the public registry", {
                extra: { probeUrl, status: response.status },
            });
            return "";
        }
        logger.info("npm registry mirror is healthy", { extra: { probeUrl } });
        return configuredMirror;
    } catch (err) {
        logger.warn("npm registry mirror is unreachable; falling back to the public registry", {
            extra: { probeUrl, err },
        });
        return "";
    }
}
