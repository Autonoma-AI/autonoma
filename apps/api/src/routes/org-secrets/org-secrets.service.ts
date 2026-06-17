import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import type { OrgSecretItem, SecretSummary } from "@autonoma/types";
import {
    CreateSecretCommand,
    GetSecretValueCommand,
    ResourceNotFoundException,
    SecretsManagerClient,
    UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

/**
 * Org-scoped secret bundles referenced by `.preview.yaml` addons via the
 * `auth_secret:` field. One PreviewkitOrgSecret row per (org, name); the
 * row holds an AWS Secrets Manager ARN whose SecretString is a JSON map.
 *
 * Mirrors `PreviewkitSecretsService` (per-app secrets) but scoped to the organization.
 * Same AWS SM JSON-map convention so the same UI patterns and item shapes
 * (`{ key, value }`) can be reused on the frontend.
 */
export class OrgSecretsService {
    private readonly client: SecretsManagerClient;
    private readonly logger: Logger;

    constructor(
        private readonly conn: PrismaClient,
        private readonly awsRegion: string,
    ) {
        this.client = new SecretsManagerClient({ region: awsRegion });
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async list(organizationId: string, name: string): Promise<SecretSummary[]> {
        this.logger.info("Listing org secret items", { organizationId, name });

        const record = await this.conn.previewkitOrgSecret.findUnique({
            where: { organizationId_name: { organizationId, name } },
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

    async upsert(organizationId: string, name: string, items: OrgSecretItem[]): Promise<void> {
        this.logger.info("Upserting org secret items", { organizationId, name, count: items.length });

        const org = await this.conn.organization.findUnique({
            where: { id: organizationId },
            select: { slug: true },
        });

        if (org == null) throw new NotFoundError("Organization not found");

        const existing = await this.conn.previewkitOrgSecret.findUnique({
            where: { organizationId_name: { organizationId, name } },
        });

        if (existing == null) {
            await this.createOrgSecret(organizationId, org.slug, name, items);
        } else {
            await this.mergeIntoSecret(existing.awsSecretArn, items);
        }
    }

    async delete(organizationId: string, name: string, key: string): Promise<void> {
        this.logger.info("Deleting org secret key", { organizationId, name, key });

        const record = await this.conn.previewkitOrgSecret.findUnique({
            where: { organizationId_name: { organizationId, name } },
        });

        if (record == null) throw new NotFoundError(`Org secret '${name}' not found`);

        const values = await this.fetchSecretValue(record.awsSecretArn);

        if (!(key in values)) throw new NotFoundError(`Secret '${key}' not found in org secret '${name}'`);

        delete values[key];

        await this.client.send(
            new UpdateSecretCommand({
                SecretId: record.awsSecretArn,
                SecretString: JSON.stringify(values),
            }),
        );

        this.logger.info("Org secret key deleted", { organizationId, name, key });
    }

    /**
     * Creates a new AWS Secrets Manager secret scoped to one (org, name)
     * pair and registers a PreviewkitOrgSecret row. The naming convention
     * `previewkit/<orgSlug>/org-secrets/<name>` mirrors the per-app scheme
     * `previewkit/<orgSlug>/<application>/<appName>` so IAM scoping stays
     * tidy on the operator side.
     */
    private async createOrgSecret(
        organizationId: string,
        orgSlug: string,
        name: string,
        items: OrgSecretItem[],
    ): Promise<void> {
        const secretName = `previewkit/${orgSlug}/org-secrets/${name}`;
        const secretValue = Object.fromEntries(items.map((i) => [i.key, i.value]));

        this.logger.info("Creating AWS secret for org-secret", { organizationId, name, secretName });

        const result = await this.client.send(
            new CreateSecretCommand({
                Name: secretName,
                SecretString: JSON.stringify(secretValue),
                Tags: [
                    { Key: "previewkit:type", Value: "org-secret" },
                    { Key: "previewkit:org", Value: orgSlug },
                    { Key: "previewkit:name", Value: name },
                ],
            }),
        );

        const arn = result.ARN;
        if (arn == null)
            throw new Error(`AWS secret created but no ARN returned for org-secret ${organizationId}/${name}`);

        await this.conn.previewkitOrgSecret.create({
            data: { organizationId, name, awsSecretArn: arn },
        });

        this.logger.info("Org secret created and registered", { organizationId, name, arn });
    }

    private async mergeIntoSecret(awsSecretArn: string, items: OrgSecretItem[]): Promise<void> {
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

            const parsed = JSON.parse(result.SecretString) as unknown;
            if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};

            return parsed as Record<string, string>;
        } catch (err: unknown) {
            if (err instanceof ResourceNotFoundException) return {};
            throw err;
        }
    }
}
