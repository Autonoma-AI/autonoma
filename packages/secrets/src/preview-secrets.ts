import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { KMSClient } from "@aws-sdk/client-kms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { KmsKeyProvider } from "./kms-key-provider";
import { SecretKeys } from "./secret-keys";
import { SecretValues } from "./secret-values";

const DEFAULT_REGION = "us-east-1";

/**
 * The app whose secret carries a preview's env, when an Application registers more
 * than one. Matches the AWS secret name the fallback builds, so both sources answer
 * with the same app's values.
 */
const PRIMARY_APP_NAME = "web";

/**
 * The AWS read this needs - `SecretsManagerClient` satisfies it. Narrow on purpose:
 * naming the one call means a test can supply the fallback's JSON, and assert it was
 * never asked for, without an AWS account.
 */
export interface SecretStringReader {
    send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

/** Which preview to read. Both fields identify it; neither is inferred from the other. */
export interface PreviewTarget {
    /** The Application that owns the preview - the tenant, stated rather than resolved. */
    applicationId: string;
    /** Only the AWS fallback needs this, to build the secret name. */
    repoFullName: string;
}

export interface PreviewSecretsConfig {
    region?: string;
    /** `PREVIEWKIT_SECRETS_READ` for the database `DATABASE_URL` points at. */
    read?: "aws" | "postgres";
    /** The CMK wrapping the encryption keys. Absent means AWS is the only source. */
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
 * Resolves the owning bundle from the Application rather than rebuilding the AWS
 * secret name. The name is a lossy guess: `previewkit/<repo>/web` misses the bundles
 * that predate that scheme, and misses any Application whose app is not called `web`
 * at all - both of which throw `ResourceNotFoundException` at the caller.
 *
 * Falls back to the name-based AWS read whenever the row or its values are missing,
 * so a repo the migration has not reached still answers.
 */
export class PreviewSecrets {
    private readonly logger: Logger;

    constructor(
        private readonly aws: SecretStringReader,
        private readonly prisma: PrismaClient = db,
        /** Absent when this environment reads AWS, or has no CMK to open Postgres with. */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    static create(config: PreviewSecretsConfig = {}): PreviewSecrets {
        const region = config.region ?? DEFAULT_REGION;
        const aws = new SecretsManagerClient({ region });
        if (config.read !== "postgres" || config.cmk == null) return new PreviewSecrets(aws);

        const keys = new SecretKeys(db, new KmsKeyProvider(new KMSClient({ region }), config.cmk));
        return new PreviewSecrets(aws, db, new SecretValues(db, keys));
    }

    /**
     * The env-var NAMES configured in a repo's preview deployment (presence/absence
     * only). A missing third-party SDK key means that SDK never initializes in
     * preview, so anything it gates falls back to its code default - which diagnoses
     * config/flag gaps without exposing secret values.
     *
     * Reads the stored key columns, so nothing is decrypted and no key is unwrapped -
     * asking which names exist must not make a plaintext value materialize. Only the
     * AWS fallback has to fetch values to list their keys, because a Secrets Manager
     * secret is one opaque blob.
     */
    async getEnvVarNames(target: PreviewTarget): Promise<string[]> {
        const names = await this.fromPostgres(target.applicationId, (bundle) => this.listNames(bundle));
        if (names != null) return names;
        return Object.keys(await this.fromAws(target.repoFullName));
    }

    /**
     * The full env-var VALUES of a repo's preview deployment - the same credentials
     * the preview app runs with, so the run-script harness can query the SAME live
     * backend the test exercised. Read-only use.
     */
    async getEnvValues(target: PreviewTarget): Promise<Record<string, string>> {
        const values = await this.fromPostgres(target.applicationId, (bundle) => this.openValues(bundle));
        if (values != null) return values;
        return this.fromAws(target.repoFullName);
    }

    /**
     * Resolves the bundle and runs `read` against it, or returns undefined for the
     * caller to fall back to AWS. Postgres holding nothing means not migrated rather
     * than empty, so a miss must not answer with an empty preview env.
     */
    private async fromPostgres<T>(
        applicationId: string,
        read: (bundle: AppBundle) => Promise<T | undefined>,
    ): Promise<T | undefined> {
        if (this.values == null) return undefined;

        try {
            const bundle = await this.resolveBundle(applicationId);
            if (bundle == null) return undefined;
            return await read(bundle);
        } catch (err) {
            this.logger.error("Failed to read a preview env from postgres; reading AWS instead", {
                applicationId,
                err,
            });
            return undefined;
        }
    }

    private async listNames(bundle: AppBundle): Promise<string[] | undefined> {
        const summaries = await this.values?.list(bundle);
        if (summaries == null || summaries.length === 0) {
            this.logger.error("Postgres holds no values for this preview; reading AWS instead", {
                applicationId: bundle.applicationId,
                extra: { appName: bundle.appName },
            });
            return undefined;
        }

        this.logger.info("Listed preview env names from postgres", {
            applicationId: bundle.applicationId,
            extra: { appName: bundle.appName, keyCount: summaries.length },
        });
        return summaries.map((summary) => summary.key);
    }

    private async openValues(bundle: AppBundle): Promise<Record<string, string> | undefined> {
        const opened = await this.values?.getAll(bundle);
        if (opened == null) {
            this.logger.error("Postgres holds no values for this preview; reading AWS instead", {
                applicationId: bundle.applicationId,
                extra: { appName: bundle.appName },
            });
            return undefined;
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
        const records = await this.prisma.previewkitSecret.findMany({
            where: { applicationId },
            select: { appName: true },
        });

        // Prefer the primary app so both sources answer with the same values, but a
        // sole registration wins whatever it is called - the reason to resolve rows
        // rather than rebuild a name.
        const chosen = records.find((record) => record.appName === PRIMARY_APP_NAME) ?? records[0];
        if (chosen == null) {
            this.logger.warn("No previewkit secret registered for this application; reading AWS instead", {
                applicationId,
            });
            return undefined;
        }
        return { kind: "app", applicationId, appName: chosen.appName };
    }

    private async fromAws(repoFullName: string): Promise<Record<string, string>> {
        const secretId = `previewkit/${repoFullName.toLowerCase()}/${PRIMARY_APP_NAME}`;
        const response = await this.aws.send(new GetSecretValueCommand({ SecretId: secretId }));

        const parsed: unknown = JSON.parse(response.SecretString ?? "{}");
        if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};

        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string") values[key] = value;
        }
        return values;
    }
}
