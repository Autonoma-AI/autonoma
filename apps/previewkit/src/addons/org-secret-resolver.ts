import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "../logger";
import type { BuildSecretSource } from "../secrets/build-secret-source";

/**
 * Resolves an `auth_secret: "name"` reference from the preview config into the
 * actual key-value map. Per-organization scope: a `PreviewkitOrgSecret` row binds
 * an org-secret name to a bundle whose keys individual providers pick from
 * (NeonProvider grabs `token`, etc.).
 *
 * Values come from `BuildSecretSource`, so this follows the same store the build
 * path does. The row is only checked for existence - it carries nothing the read
 * needs.
 *
 * This sits parallel to the per-app runtime secrets - same bundle shape, different
 * scope (org vs app) and different consumer (addon provisioning, not the K8s Secret
 * a preview's pods mount).
 */
export class OrgSecretResolver {
    private readonly logger: Logger;

    constructor(
        private readonly secrets: BuildSecretSource,
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
            select: { id: true },
        });
        if (record == null) {
            throw new Error(
                `No PreviewkitOrgSecret named "${name}" registered for organization ${organizationId}. ` +
                    `Create one via the org-secrets API before referencing it from the preview config.`,
            );
        }

        return this.secrets.forBundle({ kind: "org", organizationId, name });
    }
}
