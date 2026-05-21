import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "../logger";
import type { AwsSecretsFetcher } from "../secrets/aws-secrets-fetcher";

/**
 * Resolves a `.preview.yaml` `auth_secret: "name"` reference into the actual
 * key-value map stored in AWS Secrets Manager. Per-organization scope: a
 * `PreviewkitOrgSecret` row binds an org-secret name to an AWS SM ARN, and the
 * ARN points at a JSON map whose keys are picked by individual providers
 * (NeonProvider grabs `token`, etc.).
 *
 * This sits parallel to the existing per-app `AwsExternalSecretManager`
 * pipeline — same AWS SM JSON convention, different scope (org vs app) and
 * different consumer (addon provisioning, not runtime K8s mounting).
 */
export class OrgSecretResolver {
    private readonly logger: Logger;

    constructor(
        private readonly fetcher: AwsSecretsFetcher,
        private readonly prisma: PrismaClient = db,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Returns the parsed JSON map for the named org-secret. Throws with a
     * descriptive error if the row is missing — addon provisioning depends on
     * this resolving, so silent fallbacks would just push the failure into a
     * provider stack trace where it's harder to read.
     */
    async resolve(organizationId: string, name: string): Promise<Record<string, string>> {
        this.logger.info("Resolving org secret", { organizationId, name });

        const record = await this.prisma.previewkitOrgSecret.findUnique({
            where: { organizationId_name: { organizationId, name } },
            select: { awsSecretArn: true },
        });
        if (record == null) {
            throw new Error(
                `No PreviewkitOrgSecret named "${name}" registered for organization ${organizationId}. ` +
                    `Create one via the org-secrets API before referencing it from .preview.yaml.`,
            );
        }

        return this.fetcher.fetchJson(record.awsSecretArn);
    }
}
