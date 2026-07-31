import type { SecretValues } from "@autonoma/secrets";
import { describeSecretBundle, type SecretBundle } from "@autonoma/utils";
import { type Logger, logger as rootLogger } from "../logger";

/**
 * The values a build and its addons read, from Postgres.
 *
 * Keyed by bundle rather than by any external identifier: that is what the store
 * needs, and it is the only key that cannot resolve to the wrong owner. It also
 * owns the key-picking, so a `build_secrets:` key the bundle does not have fails
 * here rather than reaching buildctl as an empty build arg.
 *
 * There is no second store. A bundle Postgres cannot serve is an error, not a
 * reason to look elsewhere - handing a build an empty map bakes an image against
 * absent credentials, which fails far from the cause or, worse, ships.
 */
export class BuildSecretSource {
    private readonly logger: Logger;

    constructor(
        /**
         * Absent when this environment has no CMK to unwrap an encryption key with.
         * A deploy that needs no secrets is unaffected; one that does fails saying so.
         */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /** Every key and value in `bundle`. */
    async forBundle(bundle: SecretBundle): Promise<Record<string, string>> {
        return this.open(bundle);
    }

    /**
     * Just the requested keys, for the config's `build_secrets:`.
     *
     * A requested key the bundle does not have fails the build rather than inlining
     * an empty value, because a build arg that silently resolves to nothing produces
     * an image that boots and then misbehaves.
     */
    async forKeys(bundle: SecretBundle, keys: readonly string[]): Promise<Record<string, string>> {
        const values = await this.open(bundle);

        const picked: Record<string, string> = {};
        const missing: string[] = [];
        for (const key of keys) {
            const value = values[key];
            if (value == null) {
                missing.push(key);
                continue;
            }
            picked[key] = value;
        }

        if (missing.length > 0) {
            throw new Error(
                `Secrets for ${describeSecretBundle(bundle)} are missing keys requested via build_secrets: ` +
                    missing.join(", "),
            );
        }
        return picked;
    }

    private async open(bundle: SecretBundle): Promise<Record<string, string>> {
        const label = describeSecretBundle(bundle);

        if (this.values == null) {
            throw new Error(
                `Cannot read secrets for ${label}: this environment has no PREVIEWKIT_SECRETS_CMK configured, ` +
                    `so no encryption key can be unwrapped.`,
            );
        }

        // Undefined means the bundle holds no values. That is either values that never
        // landed, or a bundle whose every key was deleted - `DELETE` removes value rows
        // without removing the bundle row, so an empty bundle is a legitimate state, not
        // just a broken one. Either way nothing can serve the build, and failing beats a
        // build that succeeds against no credentials.
        const opened = await this.values.getAll(bundle);
        if (opened == null) {
            throw new Error(`No secret values are stored for ${label}, which has a registered secret bundle.`);
        }

        this.logger.info("Read secrets from postgres", {
            extra: { bundle: label, keyCount: Object.keys(opened).length },
        });
        return opened;
    }
}
