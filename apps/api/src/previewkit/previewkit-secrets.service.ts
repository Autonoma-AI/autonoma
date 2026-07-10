import { db, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import {
    CreateSecretCommand,
    DescribeSecretCommand,
    GetSecretValueCommand,
    InvalidRequestException,
    ResourceExistsException,
    ResourceNotFoundException,
    RestoreSecretCommand,
    SecretsManagerClient,
    UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import type { PreviewkitSecretsUpsertResult } from "../routes/onboarding/onboarding-dependencies";
import { secretFingerprint } from "./secret-fingerprint";

/**
 * Per-segment sanitizer for AWS Secrets Manager names. The full assembled
 * name is `previewkit/<orgSlug>/<application.name>/<appName>`. AWS SM only
 * accepts `[A-Za-z0-9_/+=.@!-]` in names; we forbid `/` per-segment too so
 * that an `app.name` like `foo/bar` does not silently change the path depth
 * of the assembled name. Any other character is replaced with `-`, then
 * runs of `-` collapse and leading/trailing `-` is trimmed for readability.
 *
 * Reference: https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html
 */
const AWS_SM_SEGMENT_INVALID_REGEX = /[^A-Za-z0-9_+=.@!-]+/g;

function sanitizeName(segment: string): string {
    const sanitized = segment.replace(AWS_SM_SEGMENT_INVALID_REGEX, "-").replace(/^-+|-+$/g, "");
    if (sanitized.length === 0) {
        throw new Error(
            `Cannot derive a valid AWS Secrets Manager name segment from "${segment}": ` +
                `all characters were stripped or the input was empty. ` +
                `Segment must contain at least one of A-Z, a-z, 0-9, _ + = . @ ! -.`,
        );
    }
    return sanitized;
}

/**
 * CRUD over per-app AWS Secrets Manager bundles, served natively from the
 * autonoma API's `/v1/previewkit/secrets/*` routes so external tooling (CI,
 * scripts) can manage secrets directly. Ported verbatim from Previewkit; the
 * logic needs only AWS Secrets Manager + the DB (no Kubernetes), so it runs in
 * the API process unchanged.
 *
 * Each (applicationId, appName) pair maps to one AWS Secrets Manager
 * secret whose SecretString is a JSON map of key->value. Writing a new
 * bundle creates the AWS SM secret (named `previewkit/<orgSlug>/<application>/<appName>`)
 * and registers a `previewkit_secret` row pointing at the ARN. The
 * runtime ExternalSecret bridge (in Previewkit's deployer) picks up new keys
 * on the next deploy.
 */
export class PreviewkitSecretsService {
    private readonly client: SecretsManagerClient;
    private readonly logger: Logger;

    constructor(
        awsRegion: string,
        private readonly prisma: PrismaClient = db,
    ) {
        this.client = new SecretsManagerClient({ region: awsRegion });
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async list(applicationId: string, appName: string, callerOrgId: string | undefined): Promise<SecretSummary[]> {
        this.logger.info("Listing secrets", { applicationId, appName });

        const app = await this.findApplication(applicationId, callerOrgId);
        // 404-on-missing semantics: returning [] for "you don't own it"
        // matches "no secrets registered yet" so the response never reveals
        // whether the application exists outside the caller's org.
        if (app == null) return [];

        const record = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
        });

        if (record == null) return [];

        const values = await this.fetchSecretValue(record.awsSecretArn);
        const now = new Date();

        return Object.entries(values)
            .map(([key, value]) => ({
                key,
                maskedLength: Math.min(value.length, 32),
                updatedAt: now,
                fingerprint: secretFingerprint(value),
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
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
     * Writes `items` into the app's AWS secret bundle, self-healing DB<->AWS drift
     * instead of failing on it. The `previewkit_secret` row is only a hint about
     * what AWS holds; when the two disagree we reconcile rather than throw:
     *   - row present but the AWS secret is gone -> recreate it and repoint the row;
     *   - no row but AWS already has the bundle -> adopt it (merge) and backfill the row;
     *   - no row and the bundle is scheduled for deletion -> restore, then adopt.
     * This keeps a save working across DB reseeds, force-deletes, and half-finished
     * prior attempts, which otherwise surface as "already exists" /
     * "scheduled for deletion" / "can't find the specified secret".
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

        const orgSlug = app.organization.slug;
        const secretName = this.buildSecretName(orgSlug, app.name, appName);
        const existing = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
        });

        // 1. We think the bundle exists: merge into it. If AWS lost it, fall through to recreate.
        if (existing != null) {
            try {
                const changed = await this.mergeIntoSecret(existing.awsSecretArn, items);
                return { created: false, changed };
            } catch (err) {
                if (!(err instanceof ResourceNotFoundException)) throw err;
                this.logger.warn("Secret row points at a missing AWS secret; recreating and repointing", {
                    applicationId,
                    appName,
                });
            }
        }

        // 2. Create the bundle; adopt it if AWS already has it (or restore if pending deletion).
        let created: boolean;
        let changed: boolean;
        let arn: string;
        try {
            arn = await this.createSecretInAws(secretName, orgSlug, app.name, appName, items);
            created = true;
            changed = true;
        } catch (err) {
            const scheduled = this.isScheduledForDeletion(err);
            if (!(err instanceof ResourceExistsException) && !scheduled) throw err;

            // Ownership gate BEFORE any mutation. The assembled name is derived from
            // lossy-sanitized, user-controlled segments, so a different (org,
            // application, appName) can resolve to the same AWS name. Only adopt a
            // bundle whose owner tags prove it is ours; refuse a foreign secret rather
            // than reading/merging/repointing onto it (which would leak + corrupt it).
            arn = await this.assertOwnedSecretArn(secretName, orgSlug, app.name, appName);

            if (scheduled) {
                this.logger.warn("AWS secret is scheduled for deletion; restoring and adopting it", {
                    applicationId,
                    appName,
                    secretName,
                });
                await this.client.send(new RestoreSecretCommand({ SecretId: secretName }));
            } else {
                this.logger.warn("AWS secret already exists without a matching DB row; adopting it", {
                    applicationId,
                    appName,
                    secretName,
                });
            }
            changed = await this.mergeIntoSecret(secretName, items);
            created = false;
        }

        // 3. Point the DB row at the reconciled secret's ARN (register it or fix a stale one).
        await this.prisma.previewkitSecret.upsert({
            where: { applicationId_appName: { applicationId, appName } },
            create: { applicationId: app.id, appName, awsSecretArn: arn },
            update: { awsSecretArn: arn },
        });
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

        const record = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
        });
        if (record == null) return undefined;

        const values = await this.fetchSecretValue(record.awsSecretArn);
        return values[key];
    }

    async delete(
        applicationId: string,
        appName: string,
        key: string,
        callerOrgId: string | undefined,
    ): Promise<boolean> {
        this.logger.info("Deleting secret", { applicationId, appName, key });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) return false;

        const record = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
        });
        if (record == null) return false;

        const values = await this.fetchSecretValue(record.awsSecretArn);
        if (!(key in values)) return false;

        delete values[key];

        await this.client.send(
            new UpdateSecretCommand({
                SecretId: record.awsSecretArn,
                SecretString: JSON.stringify(values),
            }),
        );

        this.logger.info("Secret deleted", { applicationId, appName, key });
        return true;
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
    ): Promise<{ id: string; name: string; organization: { slug: string } } | null> {
        return this.prisma.application.findFirst({
            where: callerOrgId != null ? { id: applicationId, organizationId: callerOrgId } : { id: applicationId },
            select: { id: true, name: true, organization: { select: { slug: true } } },
        });
    }

    /**
     * The AWS SM name for one (app, appName) pair, `previewkit/<orgSlug>/<application>/<appName>`.
     */
    private buildSecretName(orgSlug: string, applicationName: string, appName: string): string {
        return `previewkit/${sanitizeName(orgSlug)}/${sanitizeName(applicationName)}/${sanitizeName(appName)}`;
    }

    /**
     * Creates the AWS Secrets Manager secret (no DB write - `upsert` registers or
     * repoints the row afterwards via {@link resolveArn}). Throws
     * `ResourceExistsException` when the name is taken and `InvalidRequestException`
     * when it is scheduled for deletion; `upsert` reconciles both.
     */
    private async createSecretInAws(
        secretName: string,
        orgSlug: string,
        applicationName: string,
        appName: string,
        items: SecretItem[],
    ): Promise<string> {
        const secretValue = Object.fromEntries(items.map((i) => [i.key, i.value]));
        this.logger.info("Creating AWS secret for app", { appName, secretName });
        const result = await this.client.send(
            new CreateSecretCommand({
                Name: secretName,
                SecretString: JSON.stringify(secretValue),
                Tags: [
                    { Key: "previewkit:type", Value: "application-app" },
                    { Key: "previewkit:org", Value: orgSlug },
                    { Key: "previewkit:application", Value: applicationName },
                    { Key: "previewkit:app", Value: appName },
                ],
            }),
        );
        if (result.ARN == null) throw new Error(`AWS secret created but no ARN returned for ${secretName}`);
        return result.ARN;
    }

    /**
     * Confirms an existing AWS secret is the one WE own for (orgSlug, applicationName,
     * appName) before adopting it, and returns its ARN. The assembled name comes from
     * lossy-sanitized, user-controlled segments, so two different (application, appName)
     * pairs can collide on the same name; adopting blindly would bind - and leak/merge -
     * a different owner's bundle into this caller's row. Every secret is tagged with its
     * raw owner on create, so a tag mismatch means a collision with a foreign secret:
     * refuse (and log) rather than reconcile.
     */
    private async assertOwnedSecretArn(
        secretName: string,
        orgSlug: string,
        applicationName: string,
        appName: string,
    ): Promise<string> {
        const result = await this.client.send(new DescribeSecretCommand({ SecretId: secretName }));
        const tags = new Map((result.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
        const ownedByCaller =
            tags.get("previewkit:org") === orgSlug &&
            tags.get("previewkit:application") === applicationName &&
            tags.get("previewkit:app") === appName;
        if (!ownedByCaller) {
            this.logger.error(
                "Refusing to adopt an AWS secret whose owner tags do not match the caller " +
                    "(sanitized-name collision with a different application)",
                {
                    secretName,
                    extra: { expectedOrg: orgSlug, expectedApplication: applicationName, expectedApp: appName },
                },
            );
            throw new Error(
                `Refusing to adopt AWS secret "${secretName}": it is owned by a different (org, application, app). ` +
                    `The sanitized name collides with another application; use a distinct app name.`,
            );
        }
        if (result.ARN == null) throw new Error(`AWS secret ${secretName} has no ARN`);
        return result.ARN;
    }

    /** AWS rejects creating a secret whose name is pending deletion with InvalidRequestException. */
    private isScheduledForDeletion(err: unknown): err is InvalidRequestException {
        return err instanceof InvalidRequestException && /scheduled for deletion/i.test(err.message);
    }

    private async mergeIntoSecret(awsSecretArn: string, items: SecretItem[]): Promise<boolean> {
        const values = await this.fetchSecretValue(awsSecretArn);
        const changed = items.some((item) => values[item.key] !== item.value);
        if (!changed) return false;

        for (const item of items) {
            values[item.key] = item.value;
        }

        await this.client.send(
            new UpdateSecretCommand({
                SecretId: awsSecretArn,
                SecretString: JSON.stringify(values),
            }),
        );
        return true;
    }

    private async fetchSecretValue(secretArn: string): Promise<Record<string, string>> {
        try {
            const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));

            if (result.SecretString == null) return {};

            const parsed: unknown = JSON.parse(result.SecretString);
            if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};

            const values: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === "string") values[key] = value;
            }
            return values;
        } catch (err: unknown) {
            if (err instanceof ResourceNotFoundException) return {};
            throw err;
        }
    }
}
