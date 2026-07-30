import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { NoPrimaryEncryptionKeyError, type SecretValues } from "@autonoma/secrets";
import type { SecretBundle } from "@autonoma/utils";

/**
 * Mirrors secret writes into Postgres while AWS Secrets Manager is still the
 * authoritative store.
 *
 * Deliberately swallows its own failures. During the migration the AWS write has
 * already succeeded by the time we get here, so failing the request would break a
 * working operation to protect a copy nothing reads yet; the mirror is allowed to
 * fall behind and be repaired by the backfill instead. That trade stops holding
 * the moment reads move to Postgres, at which point these calls should lose the
 * guard and be allowed to fail the request.
 *
 * Constructed without a {@link SecretValues} the mirror is simply off, which is
 * what dev, self-host, and any environment that has not minted an encryption key
 * get.
 */
export class SecretValueMirror {
    private readonly logger: Logger;

    constructor(private readonly values?: SecretValues) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async put(bundle: SecretBundle, items: readonly { key: string; value: string }[]): Promise<void> {
        await this.attempt("seal", bundle, (values) => values.put(bundle, items));
    }

    /**
     * Compares what Postgres holds for `bundle` against the authoritative store and
     * logs any difference. A shadow read: the response the caller returns is still the
     * authoritative one, so this cannot change what a user sees - it only reports
     * whether the mirror could be trusted to serve that read yet.
     *
     * Callers that already compute fingerprints for their own response pass them
     * straight through, so this costs one two-column query and no decryption.
     */
    async audit(bundle: SecretBundle, authoritative: ReadonlyMap<string, string>): Promise<void> {
        await this.attempt("audit", bundle, async (values) => {
            const diff = await values.compare(bundle, authoritative);
            const agrees = diff.missing.length + diff.extra.length + diff.mismatched.length === 0;
            if (agrees) return;

            // Warn, not error: while AWS is authoritative a difference is expected for
            // anything the backfill has not reached, and it is the trend across bundles
            // that matters rather than any single one.
            this.logger.warn("Postgres secret mirror disagrees with AWS Secrets Manager", {
                extra: {
                    bundleKind: bundle.kind,
                    missing: diff.missing,
                    extra: diff.extra,
                    mismatched: diff.mismatched,
                },
            });
        });
    }

    async remove(bundle: SecretBundle, key: string): Promise<void> {
        await this.attempt("remove", bundle, (values) => values.remove(bundle, key));
    }

    private async attempt(
        operation: string,
        bundle: SecretBundle,
        work: (values: SecretValues) => Promise<void>,
    ): Promise<void> {
        if (this.values == null) return;

        try {
            await work(this.values);
        } catch (err) {
            // Expected until an environment has been given an encryption key, so it
            // is not worth an alert - the backfill will pick these bundles up.
            if (err instanceof NoPrimaryEncryptionKeyError) {
                this.logger.info("No encryption key yet; not mirroring to Postgres", {
                    extra: { operation, bundleKind: bundle.kind },
                });
                return;
            }

            this.logger.error(
                "Failed to mirror a secret write to Postgres; AWS Secrets Manager remains authoritative",
                err instanceof Error ? err : new Error(String(err)),
                { extra: { operation, bundleKind: bundle.kind } },
            );
        }
    }
}
