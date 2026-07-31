import { Prisma, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import type { SecretValues } from "@autonoma/secrets";
import type { OrgSecretItem, SecretSummary } from "@autonoma/types";
import type { SecretBundle } from "@autonoma/utils";

/**
 * Org-scoped secret bundles referenced by preview config addons via the
 * `auth_secret:` field. One `PreviewkitOrgSecret` row per (org, name), plus a
 * value row per key, each sealed under the environment's encryption key.
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

        const registered = await this.isRegistered(organizationId, name);
        if (!registered) return [];

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

        await this.register(organizationId, name);

        await this.store().put(this.bundleFor(organizationId, name), items);
    }

    async delete(organizationId: string, name: string, key: string): Promise<void> {
        this.logger.info("Deleting org secret key", { organizationId, name, key });

        if (!(await this.isRegistered(organizationId, name))) {
            throw new NotFoundError(`Org secret '${name}' not found`);
        }

        const removed = await this.store().remove(this.bundleFor(organizationId, name), key);
        if (!removed) throw new NotFoundError(`Secret '${key}' not found in org secret '${name}'`);

        this.logger.info("Org secret key deleted", { organizationId, name, key });
    }

    /**
     * Registers the bundle if it is not already.
     *
     * The unique constraint arbitrates. Checking and then creating lets two concurrent
     * upserts for a new bundle both decide to create it, and the loser surfaces a
     * unique violation as a 500. `prisma.upsert` is not a safe substitute either - it
     * is not guaranteed to compile to a single conflict-handling statement, so it can
     * raise the same violation under concurrency. Catching it is unambiguous, and
     * matches `PreviewkitSecretsService.register`.
     */
    private async register(organizationId: string, name: string): Promise<void> {
        try {
            // No AWS secret backs a bundle any more, so there is no ARN to record.
            await this.conn.previewkitOrgSecret.create({ data: { organizationId, name } });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
            throw err;
        }
    }

    private async isRegistered(organizationId: string, name: string): Promise<boolean> {
        const record = await this.conn.previewkitOrgSecret.findUnique({
            where: { organizationId_name: { organizationId, name } },
            select: { id: true },
        });
        return record != null;
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
