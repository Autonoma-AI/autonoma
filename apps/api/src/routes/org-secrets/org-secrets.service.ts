import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import type { SecretValues } from "@autonoma/secrets";
import type { OrgSecretItem, SecretSummary } from "@autonoma/types";
import type { SecretBundle } from "@autonoma/utils";

/**
 * Org-scoped secret bundles referenced by preview config addons via the
 * `auth_secret:` field. A bundle is the set of `PreviewkitOrgSecret` rows sharing
 * an (org, name), one per key, each sealed under the environment's encryption key -
 * there is no bundle row, so a bundle exists exactly as long as it holds a key.
 *
 * Mirrors `PreviewkitSecretsService` (per-app secrets) but scoped to the
 * organization, and with the same `{ key, value }` item shape so the frontend
 * patterns are shared.
 */
export class OrgSecretsService {
    private readonly logger: Logger;

    constructor(
        private readonly conn: PrismaClient,
        /**
         * Absent when this environment has no CMK to unwrap an encryption key with.
         * Org secrets cannot be served at all then, so the operations refuse rather
         * than quietly doing nothing.
         */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async list(organizationId: string, name: string): Promise<SecretSummary[]> {
        this.logger.info("Listing org secret items", { organizationId, name });

        // Served from the stored key columns, so nothing is decrypted and no key is
        // unwrapped to answer a listing.
        return this.store().list(this.bundleFor(organizationId, name));
    }

    async upsert(organizationId: string, name: string, items: OrgSecretItem[]): Promise<void> {
        this.logger.info("Upserting org secret items", { organizationId, name, count: items.length });

        const org = await this.conn.organization.findUnique({
            where: { id: organizationId },
            select: { id: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        await this.store().put(this.bundleFor(organizationId, name), items);
    }

    async delete(organizationId: string, name: string, key: string): Promise<void> {
        this.logger.info("Deleting org secret key", { organizationId, name, key });

        // One 404 covers both "no such bundle" and "no such key in it", because with
        // no bundle row there is nothing to tell them apart - and nothing to delete
        // either way.
        const removed = await this.store().remove(this.bundleFor(organizationId, name), key);
        if (!removed) throw new NotFoundError(`Secret '${key}' not found in org secret '${name}'`);

        this.logger.info("Org secret key deleted", { organizationId, name, key });
    }

    private bundleFor(organizationId: string, name: string): SecretBundle {
        return { kind: "org", organizationId, name };
    }

    /** The value store, or a clear refusal - see `PreviewkitSecretsService.store`. */
    private store(): SecretValues {
        if (this.values == null) {
            throw new Error(
                "Org secrets are unavailable: this environment has no PREVIEWKIT_SECRETS_CMK configured, " +
                    "so no encryption key can be unwrapped.",
            );
        }
        return this.values;
    }
}
