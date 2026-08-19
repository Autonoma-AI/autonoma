import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { describeSecretBundle, type SecretBundle, scopeFor } from "@autonoma/utils";
import { sealedSecretRow } from "./sealed-secret-row";
import { secretFingerprint } from "./secret-fingerprint";
import type { SecretKeys } from "./secret-keys";

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

/** What a stored key already holds, reduced to what decides whether a write would change it. */
interface SealedState {
    fingerprint: string;
    encryptionKeyId: string;
}

export interface SecretPutOptions {
    /**
     * Seal every given key, even one whose value and encryption key already match.
     * This is the repair path: fingerprint equality says "the same bytes went in",
     * not "the stored envelope still opens", so a row with a right fingerprint and
     * an unusable envelope (sealed under a wrong scope, truncated ciphertext) is
     * only fixed by re-sealing - which the default skip would make a no-op.
     */
    force?: boolean;
}

export interface SecretPutResult {
    /** The bundle held no keys before this write. */
    created: boolean;
    /** At least one given key's stored value differs from the one supplied. */
    changed: boolean;
    /** The keys actually sealed. The rest were already stored exactly as given. */
    written: string[];
}

/**
 * Whether writing `item` would leave the row exactly as it already is. Both halves
 * matter: the fingerprint says the value has not moved, and the key id says it is
 * sealed under the current primary rather than one a rotation has since retired.
 */
function isAlreadySealed(current: SealedState | undefined, item: SecretItem, primaryKeyId: string): boolean {
    if (current == null) return false;
    if (current.encryptionKeyId !== primaryKeyId) return false;
    return current.fingerprint === secretFingerprint(item.value);
}

/**
 * Writes previewkit secret values into Postgres, sealed with the current
 * encryption key.
 *
 * A bundle is not a row - it is the set of rows hanging off one app. Callers
 * address one as `(applicationId, appName)`, which resolves to that app row; the
 * rows themselves share only its id. A bundle holding no keys therefore has no
 * rows, and "registered but empty" is not a representable state.
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
     * A key already sealed with the same value under the current encryption key is
     * left untouched, so a row's `updatedAt` marks when that value last changed
     * rather than when it was last re-asserted. Readers depend on that distinction:
     * onboarding compares the timestamp against a preview's deploy time to decide
     * whether the running pod holds stale secrets, so a re-assert that moved it
     * would redeploy on every check. Rotation still rewrites, since re-keying moves
     * `encryptionKeyId`. Pass `force` to re-seal regardless - see
     * {@link SecretPutOptions.force} for the one case that needs it.
     *
     * The result reports what happened, so a caller can tell an unchanged value
     * apart from a write rather than assuming every call sealed something.
     *
     * Throws {@link NoPrimaryEncryptionKeyError} when no encryption key has been
     * minted, which is an environment with no CMK rather than a bad request.
     */
    async put(
        bundle: SecretBundle,
        items: readonly SecretItem[],
        options: SecretPutOptions = {},
    ): Promise<SecretPutResult> {
        if (items.length === 0) return { created: false, changed: false, written: [] };

        this.logger.info("Sealing secret values", {
            extra: { bundle: describeSecretBundle(bundle), count: items.length, force: options.force === true },
        });

        const [appId, cipher] = await Promise.all([this.requireAppId(bundle), this.keys.primary()]);
        const sealed = await this.sealedState(appId);
        const created = sealed.size === 0;
        const changed = items.some((item) => sealed.get(item.key)?.fingerprint !== secretFingerprint(item.value));
        const pending: readonly SecretItem[] =
            options.force === true
                ? items
                : items.filter((item) => !isAlreadySealed(sealed.get(item.key), item, cipher.keyId));

        if (pending.length === 0) {
            this.logger.info("Secret values already sealed as given; nothing written", {
                extra: { bundle: describeSecretBundle(bundle), count: items.length },
            });
            return { created, changed, written: [] };
        }

        const rows = pending.map((item) => ({
            key: item.key,
            ...sealedSecretRow(cipher, appId, item.key, item.value),
        }));

        await this.db.$transaction(
            rows.map((row) =>
                this.db.previewkitSecret.upsert({
                    where: { appId_key: { appId, key: row.key } },
                    create: { appId, ...row },
                    update: row,
                }),
            ),
            {
                maxWait: 30000, // Time to wait for a database connection (default: 2000ms)
                timeout: 30000,
            },
        );

        const written = rows.map((row) => row.key);
        this.logger.info("Secret values sealed", {
            extra: {
                bundle: describeSecretBundle(bundle),
                encryptionKeyId: cipher.keyId,
                count: written.length,
                unchanged: items.length - written.length,
            },
        });
        return { created, changed, written };
    }

    /**
     * The app row a bundle belongs to. Required to seal: a v2 envelope is bound to
     * this id, so a value written without one could never be opened again.
     *
     * Refusing here rather than writing a detached row is deliberate - the caller
     * has asked to store a secret for an app that is not in the topology, and the
     * honest answer is that there is nowhere to put it.
     */
    private async requireAppId(bundle: SecretBundle): Promise<string> {
        const appId = await this.findAppId(bundle);
        if (appId == null) {
            throw new Error(
                `Cannot seal a secret for app "${bundle.appName}": it is not in the application's preview topology.`,
            );
        }
        return appId;
    }

    /**
     * The app row a bundle addresses, or undefined when the application's topology
     * does not name it.
     *
     * Every read goes through here, which is also what keeps a tenant's values to
     * itself: the lookup is scoped to the bundle's application, so it cannot return
     * another application's app - and the rows hang off the app. That used to be a
     * check performed on the row after loading it; making it the way the row is
     * found at all leaves nothing to check.
     */
    private async findAppId(bundle: SecretBundle): Promise<string | undefined> {
        const app = await this.db.previewkitApp.findFirst({
            where: { name: bundle.appName, config: { applicationId: bundle.applicationId } },
            select: { id: true },
        });
        return app?.id;
    }

    /**
     * What each key in the bundle already holds, as key -> the fields that decide
     * whether writing `items` would change anything. Decrypts nothing, for the same
     * reason {@link fingerprints} does not.
     */
    private async sealedState(appId: string): Promise<Map<string, SealedState>> {
        const rows = await this.db.previewkitSecret.findMany({
            where: { appId },
            select: { key: true, fingerprint: true, encryptionKeyId: true },
        });

        return new Map(
            rows.map((row) => [row.key, { fingerprint: row.fingerprint, encryptionKeyId: row.encryptionKeyId }]),
        );
    }

    /**
     * Every key in `bundle` with the fields a listing needs, and nothing decrypted -
     * `fingerprint` and `maskedLength` were stored precisely so this is possible.
     * `updatedAt` is the row's own, so it is when that key last changed.
     *
     * `before` restricts the listing to keys that already existed at that instant. It
     * excludes keys added since, but a key DELETED since left no row - so a bounded
     * listing is a lower bound on what was there, never an exact replay.
     */
    async list(bundle: SecretBundle, before?: Date): Promise<SecretValueSummary[]> {
        const appId = await this.findAppId(bundle);
        if (appId == null) return [];

        const rows = await this.db.previewkitSecret.findMany({
            where: { appId, createdAt: before != null ? { lt: before } : undefined },
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
        const appId = await this.findAppId(bundle);
        if (appId == null) return undefined;

        const rows = await this.db.previewkitSecret.findMany({
            where: { appId },
            select: { key: true, envelope: true },
        });

        if (rows.length === 0) return undefined;

        this.logger.info("Opening a secret bundle", {
            extra: { bundle: describeSecretBundle(bundle), count: rows.length },
        });

        const opened: Record<string, string> = {};
        for (const row of rows) {
            const cipher = await this.keys.forEnvelope(row.envelope);
            opened[row.key] = cipher.decrypt(row.envelope, scopeFor(appId, row.key));
        }
        return opened;
    }

    /** One value in the clear, or undefined when the bundle has no such key. */
    async get(bundle: SecretBundle, key: string): Promise<string | undefined> {
        const appId = await this.findAppId(bundle);
        if (appId == null) return undefined;

        const row = await this.db.previewkitSecret.findUnique({
            where: { appId_key: { appId, key } },
            select: { envelope: true },
        });

        if (row == null) return undefined;

        this.logger.info("Opening a secret value", { extra: { bundle: describeSecretBundle(bundle), key } });
        const cipher = await this.keys.forEnvelope(row.envelope);
        return cipher.decrypt(row.envelope, scopeFor(appId, key));
    }

    /**
     * Removes one key from `bundle`, reporting whether it was there. An absent key
     * is not an error - it is how a caller answers "did this delete anything?".
     */
    async remove(bundle: SecretBundle, key: string): Promise<boolean> {
        this.logger.info("Removing a secret value", { extra: { bundle: describeSecretBundle(bundle), key } });

        const appId = await this.findAppId(bundle);
        if (appId == null) return false;

        const removed = await this.db.previewkitSecret.deleteMany({ where: { appId, key } });

        this.logger.info("Secret value removed", {
            extra: { bundle: describeSecretBundle(bundle), key, count: removed.count },
        });
        return removed.count > 0;
    }
}
