import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { createKmsSecretKeys } from "./kms-secret-keys";
import { SecretValues } from "./secret-values";

/**
 * The app whose secret carries a preview's env, when an Application holds more than
 * one bundle.
 */
const PRIMARY_APP_NAME = "web";

/** Which preview to read. The Application is the tenant, stated rather than resolved. */
export interface PreviewTarget {
    applicationId: string;
}

export interface PreviewSecretsConfig {
    region?: string;
    /** The CMK wrapping the encryption keys. Without it nothing can be read. */
    cmk?: string;
}

interface AppBundle {
    kind: "app";
    applicationId: string;
    appName: string;
}

/**
 * Reads a repo's preview-deployment secret - the values its preview pods run with.
 *
 * Postgres is the only store. A read it cannot serve throws, because both callers
 * turn a wrong-but-plausible answer into a stated finding: `get_preview_env` reports
 * an absent name as decisive evidence that whatever it gates fell back to a code
 * default, and `run_script` would run every request unauthenticated and report the
 * 401s as product bugs.
 */
export class PreviewSecrets {
    private readonly logger: Logger;

    constructor(
        private readonly prisma: PrismaClient = db,
        /** Absent when this environment has no CMK to unwrap an encryption key with. */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    static create(config: PreviewSecretsConfig = {}): PreviewSecrets {
        if (config.cmk == null) return new PreviewSecrets();

        const keys = createKmsSecretKeys({ db, cmk: config.cmk, region: config.region });
        return new PreviewSecrets(db, new SecretValues(db, keys));
    }

    /**
     * The env-var NAMES configured in a repo's preview deployment (presence/absence
     * only). A missing third-party SDK key means that SDK never initializes in
     * preview, so anything it gates falls back to its code default - which diagnoses
     * config/flag gaps without exposing secret values.
     *
     * Reads the stored key columns, so nothing is decrypted and no key is unwrapped -
     * asking which names exist must not make a plaintext value materialize.
     *
     * An empty list is a truthful answer here, not a miss: an app with no stored
     * secrets runs on its config's wired connections alone, and the caller unions
     * those in before deciding anything.
     *
     * `before` answers as of a past instant instead of now. Only a caller
     * reconstructing an old read passes it; a live one wants the bundle the preview
     * pods are running with.
     */
    async getEnvVarNames(target: PreviewTarget, before?: Date): Promise<string[]> {
        // Before the lookup, so an environment that cannot read at all says so rather
        // than reporting the empty list as "this preview configures nothing".
        const values = this.store();

        const bundle = await this.resolveBundle(target.applicationId);
        if (bundle == null) return [];

        const summaries = await values.list(bundle, before);
        this.logger.info("Listed preview env names from postgres", {
            applicationId: bundle.applicationId,
            extra: { appName: bundle.appName, keyCount: summaries.length, before },
        });
        return summaries.map((summary) => summary.key);
    }

    /**
     * The full env-var VALUES of a repo's preview deployment - the same credentials
     * the preview app runs with, so the run-script harness can query the SAME live
     * backend the test exercised. Read-only use.
     *
     * Throws rather than answering `{}`: a harness handed no credentials runs every
     * request unauthenticated, and reports the 401s back as product bugs.
     */
    async getEnvValues(target: PreviewTarget): Promise<Record<string, string>> {
        const values = this.store();

        const bundle = await this.resolveBundle(target.applicationId);
        const opened = bundle == null ? undefined : await values.getAll(bundle);
        if (bundle == null || opened == null) {
            throw new Error(
                `No preview secrets are stored for application ${target.applicationId}, so a script cannot be ` +
                    `run with the credentials its preview pods use.`,
            );
        }

        this.logger.info("Read preview env from postgres", {
            applicationId: bundle.applicationId,
            extra: { appName: bundle.appName, keyCount: Object.keys(opened).length },
        });
        return opened;
    }

    /**
     * The app bundle whose secret carries this preview's env.
     *
     * Keyed on the Application the caller states, so the tenant is never inferred.
     * Resolving it from the repo name instead would have to pick among the
     * environments sharing that name, and picking wrong means handing back another
     * organization's live credentials.
     */
    private async resolveBundle(applicationId: string): Promise<AppBundle | undefined> {
        // Asks the topology which apps hold values, rather than the secret rows
        // themselves: a row names only its app id now, and the name this returns
        // has to be the one the app currently carries.
        const apps = await this.prisma.previewkitApp.findMany({
            where: { config: { applicationId }, secrets: { some: {} } },
            select: { name: true },
            orderBy: { position: "asc" },
        });

        // Prefer the primary app, but a sole bundle wins whatever it is called - an
        // Application's one app is often not named `web`.
        const chosen = apps.find((app) => app.name === PRIMARY_APP_NAME) ?? apps[0];
        if (chosen == null) {
            this.logger.info("No previewkit secrets stored for this application", { applicationId });
            return undefined;
        }
        return { kind: "app", applicationId, appName: chosen.name };
    }

    /**
     * The value store, or a clear refusal. An environment with no CMK cannot unwrap
     * an encryption key, so it cannot answer at all - saying so beats an empty list
     * that reads as "this preview configures nothing".
     */
    private store(): SecretValues {
        if (this.values == null) {
            throw new Error(
                "Preview secrets are unavailable: this environment has no PREVIEWKIT_SECRETS_CMK configured, " +
                    "so no encryption key can be unwrapped.",
            );
        }
        return this.values;
    }
}
