import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { NoPrimaryEncryptionKeyError, type SecretValues, type SecretValueSummary } from "@autonoma/secrets";
import type { SecretBundle } from "@autonoma/utils";

/**
 * Mirrors secret writes into Postgres.
 *
 * Whether a failed write fails the request depends on whether this environment
 * serves its reads from here. While AWS is still the read path the write has
 * already succeeded by the time we get here, so throwing would break a working
 * operation to protect a copy nothing reads; the mirror is allowed to fall behind
 * and be repaired by the backfill.
 *
 * Once reads come from Postgres, swallowing is the dangerous option - and not
 * because reads would fail. They fall back per bundle, but only when the bundle
 * holds NOTHING: a bundle that already has values keeps serving the STALE one for
 * a key whose mirror write failed, and no fallback can see that. A build or a
 * preview would come up with the old secret and nothing would say so. So writes
 * fail the request there instead.
 *
 * Constructed without a {@link SecretValues} the mirror is simply off, which is
 * what dev, self-host, and any environment that has not minted an encryption key
 * get.
 */
export class SecretValueMirror {
    private readonly logger: Logger;

    constructor(
        private readonly values?: SecretValues,
        /** Whether this environment serves its secret reads from Postgres. */
        private readonly readsFromPostgres = false,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async put(bundle: SecretBundle, items: readonly { key: string; value: string }[]): Promise<void> {
        const failure = await this.attempt("seal", bundle, (values) => values.put(bundle, items));
        this.failIfServingReads(failure);
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
        // Never fatal, unlike the writes: this only runs when Postgres did not serve
        // the read, and a comparison that fails says nothing about whether the user's
        // write landed.
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

    /**
     * The bundle's keys from Postgres, or undefined when it cannot serve the read.
     *
     * Undefined covers two cases and both fall back to the authoritative store: the
     * mirror is off, or it holds nothing for a bundle that must have values (a bundle
     * row implies at least one, since a write requires one). Returning an empty list
     * there would show a user no secrets at all - the one outcome worse than being slow.
     */
    async list(bundle: SecretBundle): Promise<SecretValueSummary[] | undefined> {
        if (this.values == null) return undefined;

        try {
            const listed = await this.values.list(bundle);
            if (listed.length > 0) return listed;

            this.logger.error("Postgres holds no values for this bundle; serving AWS instead", {
                extra: { bundleKind: bundle.kind },
            });
            return undefined;
        } catch (err) {
            this.logger.error("Failed to list secrets from Postgres; serving AWS instead", asError(err), {
                extra: { bundleKind: bundle.kind },
            });
            return undefined;
        }
    }

    /**
     * One value from Postgres, or undefined to fall back.
     *
     * A miss here is not "no such secret". `resolveManagedSigningSecret` reads back an
     * existing AUTONOMA_SIGNING_SECRET so every app in an application shares one; a
     * false miss makes it mint a fresh one and breaks signed SDK calls from previews
     * already deployed. So an unmirrored key falls back rather than answering.
     */
    async get(bundle: SecretBundle, key: string): Promise<string | undefined> {
        if (this.values == null) return undefined;

        try {
            const value = await this.values.get(bundle, key);
            if (value != null) return value;

            this.logger.error("Postgres does not hold this secret; serving AWS instead", {
                extra: { bundleKind: bundle.kind, key },
            });
            return undefined;
        } catch (err) {
            this.logger.error("Failed to read a secret from Postgres; serving AWS instead", asError(err), {
                extra: { bundleKind: bundle.kind, key },
            });
            return undefined;
        }
    }

    async remove(bundle: SecretBundle, key: string): Promise<void> {
        const failure = await this.attempt("remove", bundle, (values) => values.remove(bundle, key));
        this.failIfServingReads(failure);
    }

    /**
     * Runs `work` and reports rather than throws, so each caller decides what a
     * failure costs. Undefined covers success, a disabled mirror, and the
     * not-yet-keyed environment - none of which leaves a stale value behind.
     */
    private async attempt(
        operation: string,
        bundle: SecretBundle,
        work: (values: SecretValues) => Promise<void>,
    ): Promise<Error | undefined> {
        if (this.values == null) return undefined;

        try {
            await work(this.values);
            return undefined;
        } catch (err) {
            // An environment with no key mirrors nothing at all, so every read falls
            // back to AWS wholesale and none of them can go stale. That makes this a
            // provisioning step to finish rather than a request to fail - though it is
            // worth an alert once reads are supposed to be served from here.
            if (err instanceof NoPrimaryEncryptionKeyError) {
                const message = "No encryption key yet; not mirroring to Postgres";
                const context = { extra: { operation, bundleKind: bundle.kind } };
                if (this.readsFromPostgres) this.logger.error(message, context);
                else this.logger.info(message, context);
                return undefined;
            }

            const failure = asError(err);
            this.logger.error("Failed to mirror a secret write to Postgres", failure, {
                extra: { operation, bundleKind: bundle.kind, readsFromPostgres: this.readsFromPostgres },
            });
            return failure;
        }
    }

    /**
     * Surfaces a mirror failure to the caller once Postgres is what reads are served
     * from, because the alternative is a bundle that quietly keeps serving the value
     * this write was meant to replace.
     */
    private failIfServingReads(failure?: Error): void {
        if (failure != null && this.readsFromPostgres) throw failure;
    }
}

/** Sentry's logger takes an Error; a thrown non-Error still has to be reportable. */
function asError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
