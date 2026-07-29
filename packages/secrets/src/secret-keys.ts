import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { readEnvelopeKeyId, SecretCipher } from "@autonoma/utils";
import { keyEncryptionContext } from "./key-encryption-context";
import type { KeyProvider } from "./key-provider";
import { NoPrimaryEncryptionKeyError } from "./no-primary-encryption-key-error";

/**
 * Resolves the cipher for a previewkit secret operation, unwrapping encryption
 * keys from `previewkit_encryption_key` on demand.
 *
 * Unwrapping happens at the point of use, not at startup: a deploy with no
 * secrets never calls the key provider at all, revoking the process's IAM takes
 * effect on the next resolve rather than whenever the pod happens to restart,
 * and each unwrap lands in the provider's audit log next to the work that needed
 * it. Material is cached per key id for the life of the instance - in the
 * previewkit runner that is one unwrap per deploy, since the runner is a
 * one-shot Job.
 */
export class SecretKeys {
    /**
     * Unwrapped keys, keyed by the key id AND the exact wrapped bytes it
     * came from. Keying on the id alone would assume an id names one material
     * forever, which nothing in the schema can enforce: delete a row and re-mint
     * the same id, and a long-lived process would keep serving its stale
     * material while a freshly started one used the new material - values sealed
     * by one then failing to open in the other with nothing but a GCM tag error
     * to go on. This cache exists to avoid KMS round trips, not database ones,
     * so paying one indexed lookup per resolve to stay correct is the right
     * trade.
     */
    private readonly ciphers = new Map<string, SecretCipher>();
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly provider: KeyProvider,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * The cipher for new writes. Which key is primary is re-read on every
     * call rather than cached, so promoting a new key takes effect
     * immediately - that is what lets a rotation skip a coordinated rollout.
     */
    async primary(): Promise<SecretCipher> {
        const row = await this.db.previewkitEncryptionKey.findFirst({
            where: { primary: true },
            orderBy: { createdAt: "desc" },
        });

        if (row == null) throw new NoPrimaryEncryptionKeyError();

        return this.resolve(row.id, row.wrap);
    }

    /** The cipher that can open `envelope`, which may be an older key than the primary. */
    async forEnvelope(envelope: string): Promise<SecretCipher> {
        const keyId = readEnvelopeKeyId(envelope);

        const row = await this.db.previewkitEncryptionKey.findUnique({ where: { id: keyId } });
        if (row == null) {
            throw new Error(
                `Cannot decrypt a secret sealed with key id "${keyId}": that encryption key is not in ` +
                    `previewkit_encryption_key. It was deleted before every value using it was re-encrypted.`,
            );
        }

        return this.resolve(row.id, row.wrap);
    }

    private async resolve(keyId: string, wrapped: Uint8Array): Promise<SecretCipher> {
        const cacheKey = `${keyId}:${Buffer.from(wrapped).toString("base64")}`;

        const cached = this.ciphers.get(cacheKey);
        if (cached != null) return cached;

        this.logger.info("Unwrapping a previewkit encryption key", { extra: { keyId } });
        const material = await this.provider.unwrap(wrapped, keyEncryptionContext(keyId));

        const cipher = new SecretCipher(keyId, material);
        this.ciphers.set(cacheKey, cipher);
        return cipher;
    }
}
