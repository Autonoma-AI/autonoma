import type { SecretValues } from "@autonoma/secrets";
import { describeSecretBundle, type SecretBundle } from "@autonoma/utils";
import { type Logger, logger as rootLogger } from "../logger";

/**
 * The AWS read this needs - `AwsSecretsFetcher` satisfies it. Narrow on purpose:
 * the fallback is one call, and naming it means a test can supply the JSON without
 * an AWS client.
 */
export interface SecretJsonFetcher {
    fetchJson(awsSecretArn: string): Promise<Record<string, string>>;
}

/** Which store answered, so a failure names the place an operator should go look. */
type Origin = "postgres" | "AWS Secrets Manager";

/**
 * Where the runner reads secret values from - Postgres when this environment has
 * been switched over, AWS Secrets Manager otherwise.
 *
 * Keyed by bundle rather than by ARN, which is what the underlying store actually
 * needs and what survives the planned drop of `awsSecretArn`. It also has to be:
 * one AWS secret can be referenced by two bundles, so ARN to bundle is not a
 * function and a reverse lookup could resolve to the wrong owner.
 */
export class BuildSecretSource {
    private readonly logger: Logger;

    constructor(
        private readonly aws: SecretJsonFetcher,
        private readonly readFromPostgres: boolean,
        /** Absent when this environment has no CMK, in which case AWS is the only source. */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });

        // Asked to read Postgres with no way to open it. Deploys keep working off AWS,
        // which is still authoritative, so this logs rather than refusing to boot - but
        // it is silent otherwise, and an environment that believes it has cut over while
        // every deploy quietly reads AWS is exactly what nobody notices.
        if (readFromPostgres && values == null) {
            this.logger.error("PREVIEWKIT_SECRETS_READ is postgres but no CMK is configured; reading AWS instead");
        }
    }

    /** Every key and value in `bundle`. */
    async forBundle(bundle: SecretBundle, awsSecretArn?: string): Promise<Record<string, string>> {
        return (await this.load(bundle, awsSecretArn)).values;
    }

    /**
     * Just the requested keys, for the config's `build_secrets:`.
     *
     * A requested key the bundle does not have fails the build rather than
     * inlining an empty value, because a build arg that silently resolves to
     * nothing produces an image that boots and then misbehaves.
     */
    async forKeys(
        bundle: SecretBundle,
        awsSecretArn: string | undefined,
        keys: readonly string[],
    ): Promise<Record<string, string>> {
        const { values, origin } = await this.load(bundle, awsSecretArn);

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
                `Secrets for ${describeSecretBundle(bundle)} in ${origin} are missing keys requested via ` +
                    `build_secrets: ${missing.join(", ")}`,
            );
        }
        return picked;
    }

    /**
     * Postgres holding nothing for a bundle means not migrated rather than empty, so
     * answering from it there would hand a build no secrets - which fails it far from
     * the cause, or worse, ships an image built without them. `awsSecretArn` is the
     * fallback for that case, and is absent for any bundle registered after Postgres
     * became the store.
     */
    private async load(
        bundle: SecretBundle,
        awsSecretArn: string | undefined,
    ): Promise<{ values: Record<string, string>; origin: Origin }> {
        if (this.readFromPostgres && this.values != null) {
            const opened = await this.fromPostgres(bundle);
            if (opened != null) return { values: opened, origin: "postgres" };
        }

        // A bundle registered after Postgres became the store has no AWS secret, so
        // there is nothing to fall back to. Failing here beats handing the build an
        // empty map, which would bake an image against absent credentials.
        if (awsSecretArn == null) {
            throw new Error(
                `Secrets for ${describeSecretBundle(bundle)} could not be read from postgres, and the bundle has ` +
                    `no AWS secret to fall back to.`,
            );
        }
        return { values: await this.aws.fetchJson(awsSecretArn), origin: "AWS Secrets Manager" };
    }

    private async fromPostgres(bundle: SecretBundle): Promise<Record<string, string> | undefined> {
        const label = describeSecretBundle(bundle);
        try {
            const opened = await this.values?.getAll(bundle);
            if (opened != null) {
                this.logger.info("Read secrets from postgres", {
                    extra: { bundle: label, keyCount: Object.keys(opened).length },
                });
                return opened;
            }

            this.logger.error("Postgres holds no values for this bundle; reading AWS instead", {
                extra: { bundle: label },
            });
            return undefined;
        } catch (err) {
            this.logger.error("Failed to read secrets from postgres; reading AWS instead", {
                extra: { bundle: label },
                err,
            });
            return undefined;
        }
    }
}
