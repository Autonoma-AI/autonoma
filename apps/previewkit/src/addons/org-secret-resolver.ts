import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "../logger";
import type { BuildSecretSource } from "../secrets/build-secret-source";

/**
 * Resolves an `auth_secret: "name"` reference from the preview config into the
 * actual key-value map. Per-organization scope: the `PreviewkitOrgSecret` rows
 * sharing an (org, name) are the bundle, and individual providers pick keys out of
 * it (NeonProvider grabs `token`, etc.).
 *
 * Values come from `BuildSecretSource`, so this follows the same store the build
 * path does. The existence check is only here for the error message: an unresolved
 * `auth_secret:` is a config mistake, and naming the fix beats the read's generic
 * "nothing is stored".
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
     * descriptive error if nothing is stored under that name — addon provisioning
     * depends on this resolving, so silent fallbacks would just push the failure
     * into a provider stack trace where it's harder to read.
     */
    async resolve(organizationId: string, name: string): Promise<Record<string, string>> {
        this.logger.info("Resolving org secret", { organizationId, name });

        const record = await this.prisma.previewkitOrgSecret.findFirst({
            where: { organizationId, name },
            select: { key: true },
        });
        if (record == null) {
            throw new Error(
                `No PreviewkitOrgSecret named "${name}" holds any value for organization ${organizationId}. ` +
                    `Create one via the org-secrets API before referencing it from the preview config.`,
            );
        }

        return this.secrets.forBundle({ kind: "org", organizationId, name });
    }
}
