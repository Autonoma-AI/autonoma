import { NotFoundError } from "@autonoma/errors";
import type { SecretItem, SecretSummary } from "@autonoma/types";
import { Service } from "../service";

interface StoredSecret {
    value: string;
    updatedAt: Date;
}

type SecretMap = Map<string, StoredSecret>;

/**
 * TODO(previewkit): Replace this in-memory store with an HTTP proxy to the previewkit
 * secrets API (apps/previewkit/src/routes/secrets.route.ts). Until then, secrets live
 * in-process so the UI can be iterated on end-to-end.
 *
 * Values are write-only from the API's perspective: callers can create, update, or
 * delete them, but there is intentionally no `reveal` endpoint. Values flow out of
 * this store only to runtime consumers (e.g. the engine), never back to the UI.
 */
export class SecretsService extends Service {
    private readonly store = new Map<string, SecretMap>();

    async list(organizationId: string, applicationId: string): Promise<SecretSummary[]> {
        this.logger.info("Listing secrets", { organizationId, applicationId });
        const secrets = this.bucket(organizationId, applicationId);
        return Array.from(secrets.entries())
            .map(([key, entry]) => ({
                key,
                maskedLength: Math.min(entry.value.length, 32),
                updatedAt: entry.updatedAt,
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
    }

    async upsert(organizationId: string, applicationId: string, items: SecretItem[]): Promise<void> {
        this.logger.info("Upserting secrets", { organizationId, applicationId, count: items.length });
        const secrets = this.bucket(organizationId, applicationId);
        const now = new Date();
        for (const item of items) {
            secrets.set(item.key, {
                value: item.value,
                updatedAt: now,
            });
        }
    }

    async delete(organizationId: string, applicationId: string, key: string): Promise<void> {
        this.logger.info("Deleting secret", { organizationId, applicationId, key });
        const secrets = this.bucket(organizationId, applicationId);
        if (!secrets.has(key)) throw new NotFoundError(`Secret '${key}' not found`);
        secrets.delete(key);
    }

    private bucket(organizationId: string, applicationId: string): SecretMap {
        const id = `${organizationId}:${applicationId}`;
        let bucket = this.store.get(id);
        if (bucket == null) {
            bucket = new Map();
            this.store.set(id, bucket);
        }
        return bucket;
    }
}
