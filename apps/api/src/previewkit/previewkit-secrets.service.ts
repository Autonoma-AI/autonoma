import { db, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { SecretValues } from "@autonoma/secrets";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import type { SecretBundle } from "@autonoma/utils";
import type { PreviewkitSecretsUpsertResult } from "../routes/onboarding/onboarding-dependencies";

/**
 * CRUD over a preview app's secret values, served from the autonoma API's
 * `/v1/previewkit/secrets/*` routes so external tooling (CI, scripts) can manage
 * secrets directly.
 *
 * Each `(applicationId, appName)` pair is one bundle: the set of `previewkit_secret`
 * rows sharing that scope, one per key, each sealed under the environment's
 * encryption key. There is no bundle row, so a bundle exists exactly as long as it
 * holds a key. The runtime materializer writes those values into the K8s Secret a
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

    async list(applicationId: string, appName: string, callerOrgId: string): Promise<SecretSummary[]> {
        this.logger.info("Listing secrets", { applicationId, appName });

        const app = await this.findApplication(applicationId, callerOrgId);
        // 404-on-missing semantics: returning [] for "you don't own it" matches "no
        // secrets registered yet" so the response never reveals whether the
        // application exists outside the caller's org.
        if (app == null) return [];

        // Served from the stored key columns, so a listing decrypts nothing and
        // unwraps no key - `maskedLength` and `fingerprint` are what it needs.
        return this.store().list(this.bundleFor(app.id, appName));
    }

    /**
     * Lists the per-app secret bundle names holding at least one secret. Each
     * (applicationId, appName) is its own bundle - a monorepo Application can
     * declare many apps in its preview config - so the UI needs this to let the
     * user pick which bundle to view; the app name rarely matches the
     * Application's slug.
     *
     * An app drops out of this list when its last key is deleted, because a bundle
     * is its rows and there is nothing left to name.
     */
    async listApps(applicationId: string, callerOrgId: string): Promise<string[]> {
        this.logger.info("Listing secret app bundles", { applicationId });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return [];

        const apps = await this.prisma.previewkitApp.findMany({
            where: { config: { applicationId }, secrets: { some: {} } },
            select: { name: true },
            orderBy: { name: "asc" },
        });
        return apps.map((app) => app.name);
    }

    /**
     * Writes `items` into the app's bundle.
     *
     * Both flags come from the read `put` already does to decide what to write, so
     * deciding them costs no extra round trip and decrypts nothing: `created` means
     * the bundle held no keys before this write, and `changed` that at least one
     * value moved. Onboarding redeploys on `created`, and two writes racing a
     * brand-new bundle can both report it - the extra redeploy is superseded by the
     * newer one, which is cheaper than serializing every secret write to make the
     * flag exact.
     *
     * `changed` is not "did `put` write": a key already sealed as given is skipped,
     * and one whose encryption key has rotated underneath it is rewritten without
     * its value having moved.
     */
    async upsert(
        applicationId: string,
        appName: string,
        items: SecretItem[],
        callerOrgId: string,
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

        const { created, changed } = await values.put(bundle, items);

        return { created, changed };
    }

    /** Reads back a single secret's plaintext value (unlike {@link list}, unmasked); trusted server-side callers only. */
    async getValue(
        applicationId: string,
        appName: string,
        key: string,
        callerOrgId: string,
    ): Promise<string | undefined> {
        this.logger.info("Reading secret value", { applicationId, appName, extra: { key } });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return undefined;

        return this.store().get(this.bundleFor(app.id, appName), key);
    }

    /** Returns whether the key was there to remove. */
    async delete(applicationId: string, appName: string, key: string, callerOrgId: string): Promise<boolean> {
        this.logger.info("Deleting secret", { applicationId, appName, key });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return false;

        const removed = await this.store().remove(this.bundleFor(app.id, appName), key);
        if (removed) this.logger.info("Secret deleted", { applicationId, appName, key });
        return removed;
    }

    /**
     * Resolves the Application referenced in the URL, narrowed to the caller's org. Returning `null` rather than
     * throwing is what makes 404 / "[]" responses indistinguishable from "doesn't exist", so the API never leaks
     * cross-org existence.
     */
    private async findApplication(applicationId: string, callerOrgId: string): Promise<SecretBundleOwner | null> {
        return this.prisma.application.findFirst({
            where: { id: applicationId, organizationId: callerOrgId },
            select: { id: true, name: true, organization: { select: { slug: true } } },
        });
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
