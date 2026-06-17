import { db, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import {
    CreateSecretCommand,
    GetSecretValueCommand,
    ResourceNotFoundException,
    SecretsManagerClient,
    UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

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
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
    }

    /**
     * Lists the per-app secret bundle names registered for an application.
     * Each (applicationId, appName) is its own bundle - a monorepo Application
     * can declare many apps in `.preview.yaml` - so the UI needs this to let
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

    async upsert(
        applicationId: string,
        appName: string,
        items: SecretItem[],
        callerOrgId: string | undefined,
    ): Promise<void> {
        if (items.length === 0) {
            throw new Error("Refusing to upsert: items must contain at least one entry");
        }
        this.logger.info("Upserting secrets", { applicationId, appName, count: items.length });

        const app = await this.findApplication(applicationId, callerOrgId);
        if (app == null) {
            throw new NotFoundError(`Application not found: ${applicationId}`);
        }

        const existing = await this.prisma.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName } },
        });

        if (existing == null) {
            await this.createAppSecret(app, app.organization.slug, appName, items);
        } else {
            await this.mergeIntoSecret(existing.awsSecretArn, items);
        }
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
     * Allocates a new AWS Secrets Manager secret for one (app, appName)
     * pair and registers the ARN as a PreviewkitSecret row. AWS SM names
     * follow `previewkit/<orgSlug>/<application>/<appName>` for tidy IAM
     * scoping.
     */
    private async createAppSecret(
        app: { id: string; name: string },
        orgSlug: string,
        appName: string,
        items: SecretItem[],
    ): Promise<void> {
        const sanitizedOrgSlug = sanitizeName(orgSlug);
        const sanitizedApplicationName = sanitizeName(app.name);
        const sanitizedAppName = sanitizeName(appName);
        const secretName = `previewkit/${sanitizedOrgSlug}/${sanitizedApplicationName}/${sanitizedAppName}`;

        const secretValue = Object.fromEntries(items.map((i) => [i.key, i.value]));

        this.logger.info("Creating AWS secret for app", { applicationId: app.id, appName, secretName });

        const result = await this.client.send(
            new CreateSecretCommand({
                Name: secretName,
                SecretString: JSON.stringify(secretValue),
                Tags: [
                    { Key: "previewkit:type", Value: "application-app" },
                    { Key: "previewkit:org", Value: orgSlug },
                    { Key: "previewkit:application", Value: app.name },
                    { Key: "previewkit:app", Value: appName },
                ],
            }),
        );

        const arn = result.ARN;
        if (arn == null) throw new Error(`AWS secret created but no ARN returned for app ${app.id}/${appName}`);

        await this.prisma.previewkitSecret.create({
            data: { applicationId: app.id, appName, awsSecretArn: arn },
        });

        this.logger.info("AWS secret created and registered", { applicationId: app.id, appName, arn });
    }

    private async mergeIntoSecret(awsSecretArn: string, items: SecretItem[]): Promise<void> {
        const values = await this.fetchSecretValue(awsSecretArn);

        for (const item of items) {
            values[item.key] = item.value;
        }

        await this.client.send(
            new UpdateSecretCommand({
                SecretId: awsSecretArn,
                SecretString: JSON.stringify(values),
            }),
        );
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
