import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { describeSecretBundle, type SecretBundle, scopeIn } from "@autonoma/utils";
import { secretFingerprint } from "./secret-fingerprint";
import type { SecretKeys } from "./secret-keys";

/** How much of a value's length `maskedLength` will admit to, so long values do not leak their size. */
const MAX_MASKED_LENGTH = 32;

export interface SecretItem {
    key: string;
    value: string;
}

export interface SecretValueSummary {
    key: string;
    fingerprint: string;
    maskedLength: number;
    updatedAt: Date;
}

/**
 * Writes previewkit secret values into Postgres, sealed with the current
 * encryption key.
 *
 * A bundle is not a row - it is the set of rows sharing a scope, either
 * `(applicationId, appName)` or `(organizationId, name)`. A bundle holding no keys
 * therefore has no rows, and "registered but empty" is not a representable state.
 *
 * Rows carry `fingerprint` and `maskedLength` alongside the envelope, computed
 * here at seal time. That is deliberate: listing a bundle needs key names and an
 * "is this the value I already hold?" check, never the values themselves, so
 * storing those two derived fields means a list can be served without unwrapping
 * a key or decrypting anything.
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
     * Seals `items` into `bundle`, leaving keys it was not given alone - a caller
     * writing one key does not drop the rest.
     *
     * Throws {@link NoPrimaryEncryptionKeyError} when no encryption key has been
     * minted, which is an environment with no CMK rather than a bad request.
     */
    async put(bundle: SecretBundle, items: readonly SecretItem[]): Promise<void> {
        if (items.length === 0) return;

        this.logger.info("Sealing secret values", {
            extra: { bundle: describeSecretBundle(bundle), count: items.length },
        });

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
                    ? this.db.previewkitSecret.upsert({
                          where: {
                              applicationId_appName_key: {
                                  applicationId: bundle.applicationId,
                                  appName: bundle.appName,
                                  key: row.key,
                              },
                          },
                          create: { applicationId: bundle.applicationId, appName: bundle.appName, ...row },
                          update: row,
                      })
                    : this.db.previewkitOrgSecret.upsert({
                          where: {
                              organizationId_name_key: {
                                  organizationId: bundle.organizationId,
                                  name: bundle.name,
                                  key: row.key,
                              },
                          },
                          create: { organizationId: bundle.organizationId, name: bundle.name, ...row },
                          update: row,
                      }),
            ),
            {
                maxWait: 30000, // Time to wait for a database connection (default: 2000ms)
                timeout: 30000,
            },
        );

        this.logger.info("Secret values sealed", {
            extra: { bundle: describeSecretBundle(bundle), encryptionKeyId: cipher.keyId, count: rows.length },
        });
    }

    /**
     * What the bundle holds, as key -> fingerprint. Reads two columns and decrypts
     * nothing, which is the whole point of storing the fingerprint.
     */
    async fingerprints(bundle: SecretBundle): Promise<Map<string, string>> {
        const rows =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.findMany({
                      where: { applicationId: bundle.applicationId, appName: bundle.appName },
                      select: { key: true, fingerprint: true },
                  })
                : await this.db.previewkitOrgSecret.findMany({
                      where: { organizationId: bundle.organizationId, name: bundle.name },
                      select: { key: true, fingerprint: true },
                  });

        return new Map(rows.map((row) => [row.key, row.fingerprint]));
    }

    /**
     * Every key in `bundle` with the fields a listing needs, and nothing decrypted -
     * `fingerprint` and `maskedLength` were stored precisely so this is possible.
     * `updatedAt` is the row's own, so it is when that key last changed.
     */
    async list(bundle: SecretBundle): Promise<SecretValueSummary[]> {
        const rows =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.findMany({
                      where: { applicationId: bundle.applicationId, appName: bundle.appName },
                      select: { key: true, fingerprint: true, maskedLength: true, updatedAt: true },
                  })
                : await this.db.previewkitOrgSecret.findMany({
                      where: { organizationId: bundle.organizationId, name: bundle.name },
                      select: { key: true, fingerprint: true, maskedLength: true, updatedAt: true },
                  });

        return rows.sort((a, b) => a.key.localeCompare(b.key));
    }

    /**
     * Every value in the bundle, in the clear. Undefined when the bundle holds
     * nothing, which the callers building or deploying against it treat as a failure
     * rather than as an empty environment.
     *
     * One key unwrap covers the whole bundle: `forEnvelope` caches per key version, so
     * a bundle sealed under a single version costs one round trip regardless of size.
     */
    async getAll(bundle: SecretBundle): Promise<Record<string, string> | undefined> {
        const rows =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.findMany({
                      where: { applicationId: bundle.applicationId, appName: bundle.appName },
                      select: { key: true, envelope: true },
                  })
                : await this.db.previewkitOrgSecret.findMany({
                      where: { organizationId: bundle.organizationId, name: bundle.name },
                      select: { key: true, envelope: true },
                  });

        if (rows.length === 0) return undefined;

        this.logger.info("Opening a secret bundle", {
            extra: { bundle: describeSecretBundle(bundle), count: rows.length },
        });

        const opened: Record<string, string> = {};
        for (const row of rows) {
            const cipher = await this.keys.forEnvelope(row.envelope);
            opened[row.key] = cipher.decrypt(row.envelope, scopeIn(bundle, row.key));
        }
        return opened;
    }

    /** One value in the clear, or undefined when the bundle has no such key. */
    async get(bundle: SecretBundle, key: string): Promise<string | undefined> {
        const row =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.findUnique({
                      where: {
                          applicationId_appName_key: {
                              applicationId: bundle.applicationId,
                              appName: bundle.appName,
                              key,
                          },
                      },
                      select: { envelope: true },
                  })
                : await this.db.previewkitOrgSecret.findUnique({
                      where: {
                          organizationId_name_key: {
                              organizationId: bundle.organizationId,
                              name: bundle.name,
                              key,
                          },
                      },
                      select: { envelope: true },
                  });

        if (row == null) return undefined;

        this.logger.info("Opening a secret value", { extra: { bundle: describeSecretBundle(bundle), key } });
        const cipher = await this.keys.forEnvelope(row.envelope);
        return cipher.decrypt(row.envelope, scopeIn(bundle, key));
    }

    /**
     * Removes one key from `bundle`, reporting whether it was there. An absent key
     * is not an error - it is how a caller answers "did this delete anything?".
     */
    async remove(bundle: SecretBundle, key: string): Promise<boolean> {
        this.logger.info("Removing a secret value", { extra: { bundle: describeSecretBundle(bundle), key } });

        const removed =
            bundle.kind === "app"
                ? await this.db.previewkitSecret.deleteMany({
                      where: { applicationId: bundle.applicationId, appName: bundle.appName, key },
                  })
                : await this.db.previewkitOrgSecret.deleteMany({
                      where: { organizationId: bundle.organizationId, name: bundle.name, key },
                  });

        this.logger.info("Secret value removed", {
            extra: { bundle: describeSecretBundle(bundle), key, count: removed.count },
        });
        return removed.count > 0;
    }
}
