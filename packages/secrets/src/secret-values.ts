import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type SecretBundle, scopeIn } from "@autonoma/utils";
import { secretFingerprint } from "./secret-fingerprint";
import type { SecretKeys } from "./secret-keys";

/**
 * How much of a value's length `maskedLength` will admit to, so long values do not
 * leak their size. Exported because the AWS-backed reads compute the same field
 * for the same `SecretSummary`, and the two must not drift apart.
 */
export const MAX_MASKED_LENGTH = 32;

export interface SecretItem {
    key: string;
    value: string;
}

/** How Postgres differs from the authoritative store for one bundle. Empty everywhere means they agree. */
export interface MirrorComparison {
    /** Keys the authoritative store has that Postgres does not - usually not backfilled yet. */
    missing: string[];
    /** Keys Postgres has that the authoritative store does not - usually deleted before dual-write existed. */
    extra: string[];
    /** Keys both have, holding different values. */
    mismatched: string[];
}

/**
 * Writes previewkit secret values into Postgres, sealed with the current
 * encryption key.
 *
 * Rows carry `fingerprint` and `maskedLength` alongside the envelope, computed
 * here at seal time. That is deliberate: listing a bundle needs key names and an
 * "is this the value I already hold?" check, never the values themselves, so
 * storing those two derived fields means a list can be served without unwrapping
 * a key or decrypting anything.
 *
 * Persistence lives in this package rather than in the API services because the
 * services build their AWS client internally and cannot be exercised without an
 * AWS account; keeping the database work here makes it coverable by integration
 * tests against a real Postgres.
 */
export class SecretValues {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly keys: SecretKeys,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Seals `items` and upserts them into `bundle`, leaving keys it was not given
     * alone - the same merge semantics the authoritative store uses, so a caller
     * writing one key does not drop the rest.
     *
     * Throws {@link NoPrimaryEncryptionKeyError} when no encryption key has been minted,
     * which a caller mirroring writes during the migration can treat as "not
     * provisioned yet" rather than as a failure.
     */
    async put(bundle: SecretBundle, items: readonly SecretItem[]): Promise<void> {
        if (items.length === 0) return;

        this.logger.info("Sealing secret values", { extra: { bundle: describe(bundle), count: items.length } });

        const parentId = await this.parentId(bundle);
        if (parentId == null) return;

        const cipher = await this.keys.primary();
        const rows = items.map((item) => ({
            key: item.key,
            envelope: cipher.encrypt(item.value, scopeIn(bundle, item.key)),
            encryptionKeyId: cipher.keyId,
            fingerprint: secretFingerprint(item.value),
            maskedLength: Math.min(item.value.length, MAX_MASKED_LENGTH),
        }));

        await this.db.$transaction(
            rows.map((row) =>
                bundle.kind === "app"
                    ? this.db.previewkitSecretValue.upsert({
                          where: { secretId_key: { secretId: parentId, key: row.key } },
                          create: { secretId: parentId, ...row },
                          update: row,
                      })
                    : this.db.previewkitOrgSecretValue.upsert({
                          where: { orgSecretId_key: { orgSecretId: parentId, key: row.key } },
                          create: { orgSecretId: parentId, ...row },
                          update: row,
                      }),
            ),
            {
                maxWait: 30000, // Time to wait for a database connection (default: 2000ms)
                timeout: 30000,
            },
        );

        this.logger.info("Secret values sealed", {
            extra: { bundle: describe(bundle), encryptionKeyId: cipher.keyId, count: rows.length },
        });
    }

    /**
     * What Postgres holds for `bundle`, as key -> fingerprint. Reads two columns and
     * decrypts nothing, which is the whole point of storing the fingerprint.
     */
    async fingerprints(bundle: SecretBundle): Promise<Map<string, string>> {
        const rows =
            bundle.kind === "app"
                ? await this.db.previewkitSecretValue.findMany({
                      where: { secret: { applicationId: bundle.applicationId, appName: bundle.appName } },
                      select: { key: true, fingerprint: true },
                  })
                : await this.db.previewkitOrgSecretValue.findMany({
                      where: { orgSecret: { organizationId: bundle.organizationId, name: bundle.name } },
                      select: { key: true, fingerprint: true },
                  });

        return new Map(rows.map((row) => [row.key, row.fingerprint]));
    }

    /**
     * How Postgres differs from the authoritative store for `bundle`, given what that
     * store holds as key -> fingerprint.
     *
     * This is what earns the right to serve reads from here. A caller already
     * computing fingerprints for its own response can compare for free, so every
     * bundle anyone looks at reports whether the mirror agrees - continuous
     * verification rather than a one-off backfill check.
     */
    async compare(bundle: SecretBundle, authoritative: ReadonlyMap<string, string>): Promise<MirrorComparison> {
        const mirrored = await this.fingerprints(bundle);

        return {
            missing: [...authoritative.keys()].filter((key) => !mirrored.has(key)).sort(),
            extra: [...mirrored.keys()].filter((key) => !authoritative.has(key)).sort(),
            mismatched: [...authoritative.entries()]
                .filter(([key, fingerprint]) => mirrored.has(key) && mirrored.get(key) !== fingerprint)
                .map(([key]) => key)
                .sort(),
        };
    }

    /** Removes one key from `bundle`. Absent keys are not an error - the caller's authoritative store decides that. */
    async remove(bundle: SecretBundle, key: string): Promise<void> {
        this.logger.info("Removing a secret value", { extra: { bundle: describe(bundle), key } });

        const parentId = await this.parentId(bundle);
        if (parentId == null) return;

        const removed =
            bundle.kind === "app"
                ? await this.db.previewkitSecretValue.deleteMany({ where: { secretId: parentId, key } })
                : await this.db.previewkitOrgSecretValue.deleteMany({ where: { orgSecretId: parentId, key } });

        this.logger.info("Secret value removed", { extra: { bundle: describe(bundle), key, count: removed.count } });
    }

    /**
     * The parent bundle row's id, or undefined when the bundle has not been
     * registered. Undefined is not an error: while the authoritative store is
     * still AWS, a bundle can legitimately exist there before anything mirrors it
     * here, and a value row cannot be written without its parent.
     */
    private async parentId(bundle: SecretBundle): Promise<string | undefined> {
        const row =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.findUnique({
                      where: {
                          applicationId_appName: { applicationId: bundle.applicationId, appName: bundle.appName },
                      },
                      select: { id: true },
                  })
                : await this.db.previewkitOrgSecret.findUnique({
                      where: { organizationId_name: { organizationId: bundle.organizationId, name: bundle.name } },
                      select: { id: true },
                  });

        if (row == null) {
            this.logger.warn("No secret bundle row to attach values to; skipping", {
                extra: { bundle: describe(bundle) },
            });
        }
        return row?.id;
    }
}

/** Bundle identity for logs - never a secret key name or value. */
function describe(bundle: SecretBundle): string {
    return bundle.kind === "app"
        ? `app:${bundle.applicationId}/${bundle.appName}`
        : `org:${bundle.organizationId}/${bundle.name}`;
}
