import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import {
    CreateSecretCommand,
    GetSecretValueCommand,
    ResourceNotFoundException,
    SecretsManagerClient,
    UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

export class SecretsService {
    private readonly client: SecretsManagerClient;
    private readonly logger: Logger;

    constructor(
        private readonly conn: PrismaClient,
        private readonly awsRegion: string,
    ) {
        this.client = new SecretsManagerClient({ region: awsRegion });
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async list(organizationId: string, applicationId: string): Promise<SecretSummary[]> {
        this.logger.info("Listing secrets", { organizationId, applicationId });

        const record = await this.conn.previewkitSecret.findFirst({
            where: { applicationId, application: { organizationId } },
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

    async upsert(organizationId: string, applicationId: string, items: SecretItem[]): Promise<void> {
        this.logger.info("Upserting secrets", { organizationId, applicationId, count: items.length });

        const app = await this.conn.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true, name: true, organization: { select: { slug: true } } },
        });

        if (app == null) throw new NotFoundError("Application not found");

        const existing = await this.conn.previewkitSecret.findUnique({
            where: { applicationId },
        });

        if (existing == null) {
            await this.createAppSecret(app, app.organization.slug, items);
        } else {
            await this.mergeIntoSecret(existing.awsSecretArn, items);
        }
    }

    async delete(organizationId: string, applicationId: string, key: string): Promise<void> {
        this.logger.info("Deleting secret", { organizationId, applicationId, key });

        const record = await this.conn.previewkitSecret.findFirst({
            where: { applicationId, application: { organizationId } },
        });

        if (record == null) throw new NotFoundError(`Secret '${key}' not found`);

        const values = await this.fetchSecretValue(record.awsSecretArn);

        if (!(key in values)) throw new NotFoundError(`Secret '${key}' not found`);

        delete values[key];

        await this.client.send(
            new UpdateSecretCommand({
                SecretId: record.awsSecretArn,
                SecretString: JSON.stringify(values),
            }),
        );

        this.logger.info("Secret deleted", { applicationId, key });
    }

    private async createAppSecret(
        app: { id: string; name: string },
        orgSlug: string,
        items: SecretItem[],
    ): Promise<void> {
        const secretName = `previewkit/${orgSlug}/${app.name}`;
        const secretValue = Object.fromEntries(items.map((i) => [i.key, i.value]));

        this.logger.info("Creating AWS secret for app", { applicationId: app.id, secretName });

        const result = await this.client.send(
            new CreateSecretCommand({
                Name: secretName,
                SecretString: JSON.stringify(secretValue),
                Tags: [
                    { Key: "previewkit:type", Value: "organization" },
                    { Key: "previewkit:org", Value: orgSlug },
                    { Key: "previewkit:app", Value: app.name },
                ],
            }),
        );

        const arn = result.ARN;
        if (arn == null) throw new Error(`AWS secret created but no ARN returned for app ${app.id}`);

        const k8sSecretName = this.toK8sName(app.name);

        await this.conn.previewkitSecret.create({
            data: { applicationId: app.id, awsSecretArn: arn, k8sSecretName },
        });

        this.logger.info("AWS secret created and registered", { applicationId: app.id, arn, k8sSecretName });
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

            const parsed = JSON.parse(result.SecretString) as unknown;
            if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};

            return parsed as Record<string, string>;
        } catch (err: unknown) {
            if (err instanceof ResourceNotFoundException) return {};
            throw err;
        }
    }

    private toK8sName(appName: string): string {
        return appName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 55)
            .concat("-secrets");
    }
}
