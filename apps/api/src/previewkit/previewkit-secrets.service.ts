import { db, Prisma, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { secretFingerprint, type SecretValues } from "@autonoma/secrets";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import type { SecretBundle } from "@autonoma/utils";
import type { PreviewkitSecretsUpsertResult } from "../routes/onboarding/onboarding-dependencies";

/**
 * CRUD over a preview app's secret values, served from the autonoma API's
 * `/v1/previewkit/secrets/*` routes so external tooling (CI, scripts) can manage
 * secrets directly.
 *
 * Each `(applicationId, appName)` pair is one bundle: a `previewkit_secret` row
 * plus a value row per key, each value sealed under the environment's encryption
 * key. The runtime materializer writes those values into the K8s Secret a
 * preview's pods mount on the next deploy.
 *
 * There is no name to derive and no global namespace to collide in. That is what
 * retired the ownership tags and the whole self-heal path this service used to
 * carry: adoption, refusal on a foreign owner, recreate-on-deleted and
 * restore-from-scheduled-deletion were all consequences of AWS Secrets Manager
 * names being one flat space shared by every tenant. A bundle is now identified by
 * a foreign key into the Application that owns it, so none of those states exist.
 */
/** The Application a bundle belongs to, resolved for the caller's org. */
interface SecretBundleOwner {
    id: string;
    name: string;
    organization: { slug: string };
}

export class PreviewkitSecretsService {
    private readonly logger: Logger;

    constructor(
        private readonly prisma: PrismaClient = db,
        /**
         * Absent when this environment has no CMK to unwrap an encryption key with,
         * which is dev and self-host. Previewkit secrets cannot be served at all
         * then, so the operations refuse rather than quietly doing nothing.
         */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async list(applicationId: string, appName: string, callerOrgId: string | undefined): Promise<SecretSummary[]> {
        this.logger.info("Listing secrets", { applicationId, appName });

        const app = await this.findApplication(applicationId, callerOrgId);
        // 404-on-missing semantics: returning [] for "you don't own it" matches "no
        // secrets registered yet" so the response never reveals whether the
        // application exists outside the caller's org.
        if (app == null) return [];

        const registered = await this.isRegistered(applicationId, appName);
        if (!registered) return [];

        // Served from the stored key columns, so a listing decrypts nothing and
        // unwraps no key - `maskedLength` and `fingerprint` are what it needs.
        return this.store().list(this.bundleFor(app.id, appName));
    }

    /**
     * Lists the per-app secret bundle names registered for an application.
     * Each (applicationId, appName) is its own bundle - a monorepo Application
     * can declare many apps in its preview config - so the UI needs this to let
     * the user pick which bundle to view; the app name rarely matches the
     * Application's slug.
     */
    async listApps(applicationId: string, callerOrgId: string | undefined): Promise<string[]> {
        this.logger.info("Listing secret app bundles", { applicationId });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return [];

        const rows = await this.prisma.previewkitSecret.findMany({
            where: { applicationId },
            select: { appName: true },
            orderBy: { appName: "asc" },
        });
        return rows.map((row) => row.appName);
    }

    /**
     * Writes `items` into the app's bundle, registering the bundle if this is its
     * first secret.
     *
     * `changed` is computed from the stored fingerprints rather than by reading the
     * values back, so deciding whether anything moved costs one two-column query and
     * no decryption.
     */
    async upsert(
        applicationId: string,
        appName: string,
        items: SecretItem[],
        callerOrgId: string | undefined,
    ): Promise<PreviewkitSecretsUpsertResult> {
        if (items.length === 0) {
            throw new Error("Refusing to upsert: items must contain at least one entry");
        }
        this.logger.info("Upserting secrets", { applicationId, appName, count: items.length });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) {
            throw new NotFoundError(`Application not found: ${applicationId}`);
        }

        const values = this.store();
        const bundle = this.bundleFor(app.id, appName);

        const created = await this.register(app.id, appName);

        const stored = created ? new Map<string, string>() : await values.fingerprints(bundle);
        const changed = items.some((item) => stored.get(item.key) !== secretFingerprint(item.value));

        // Written even when nothing changed: `changed` reports whether the values
        // moved, not whether the write happened, and re-sealing an unchanged value is
        // how a rotation re-keys it.
        await values.put(bundle, items);

        return { created, changed };
    }

    /** Reads back a single secret's plaintext value (unlike {@link list}, unmasked); trusted server-side callers only. */
    async getValue(
        applicationId: string,
        appName: string,
        key: string,
        callerOrgId: string | undefined,
    ): Promise<string | undefined> {
        this.logger.info("Reading secret value", { applicationId, appName, extra: { key } });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return undefined;

        return this.store().get(this.bundleFor(app.id, appName), key);
    }

    /** Returns whether the key was there to remove. */
    async delete(
        applicationId: string,
        appName: string,
        key: string,
        callerOrgId: string | undefined,
    ): Promise<boolean> {
        this.logger.info("Deleting secret", { applicationId, appName, key });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return false;

        const removed = await this.store().remove(this.bundleFor(app.id, appName), key);
        if (removed) this.logger.info("Secret deleted", { applicationId, appName, key });
        return removed;
    }

    /**
     * Resolves the Application referenced in the URL, narrowed by the
     * caller's org when set. Returning `null` when the org doesn't match
     * is what makes 404 / "[]" responses indistinguishable from "doesn't
     * exist", so the API never leaks cross-org existence.
     *
     * `callerOrgId == null` indicates a service-secret caller (autonoma
     * internal): we trust the URL and don't narrow by org.
     */
    private async findApplication(
        applicationId: string,
        callerOrgId: string | undefined,
    ): Promise<SecretBundleOwner | null> {
        return this.prisma.application.findFirst({
            where: callerOrgId != null ? { id: applicationId, organizationId: callerOrgId } : { id: applicationId },
            select: { id: true, name: true, organization: { select: { slug: true } } },
        });
    }

    /**
     * Registers the bundle if it is not already, reporting whether this call is the
     * one that did it.
     *
     * The unique constraint arbitrates, not a prior read. Checking and then creating
     * lets two concurrent upserts for a new bundle both decide to create it, and the
     * loser surfaces a unique violation as a 500 - which is reachable from two CI
     * `PUT`s, or an onboarding save racing a direct one. `created` has to stay exact
     * because onboarding uses it to decide whether to redeploy, so this cannot just
     * be an idempotent upsert.
     */
    private async register(applicationId: string, appName: string): Promise<boolean> {
        try {
            // No AWS secret backs a bundle any more, so there is no ARN to record.
            await this.prisma.previewkitSecret.create({ data: { applicationId, appName } });
            return true;
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
            throw err;
        }
    }

    /** Whether the bundle has been registered, which is what makes a read answer [] rather than throw. */
    private async isRegistered(applicationId: string, appName: string): Promise<boolean> {
        const record = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
            select: { id: true },
        });
        return record != null;
    }

    private bundleFor(applicationId: string, appName: string): SecretBundle {
        return { kind: "app", applicationId, appName };
    }

    /**
     * The value store, or a clear refusal. An environment with no CMK cannot unwrap
     * an encryption key, so it cannot serve these routes at all - failing here says
     * so, rather than returning an empty list that reads as "you have no secrets".
     */
    private store(): SecretValues {
        if (this.values == null) {
            throw new Error(
                "Previewkit secrets are unavailable: this environment has no PREVIEWKIT_SECRETS_CMK configured, " +
                    "so no encryption key can be unwrapped.",
            );
        }
        return this.values;
    }
}
