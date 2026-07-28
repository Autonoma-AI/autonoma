import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { SecretCipher } from "@autonoma/utils";
import { keyEncryptionContext } from "./key-encryption-context";
import type { KeyProvider } from "./key-provider";

export interface MintSecretKeyParams {
    db: PrismaClient;
    provider: KeyProvider;
    /** Names the generation and is stamped into every envelope it seals, e.g. "1". */
    keyId: string;
}

/**
 * Creates a key generation and promotes it to primary. An operator action, run
 * once to bootstrap an environment and again for each rotation - never on a
 * request path, so that a misconfigured process can never silently mint itself a
 * key and start writing values nothing else can read.
 *
 * Only the wrapped key is stored. Existing values keep resolving to the
 * generation named in their own envelope, so promoting a new primary is safe
 * without re-encrypting anything first.
 */
export async function mintSecretKey({ db, provider, keyId }: MintSecretKeyParams): Promise<void> {
    const logger = rootLogger.child({ name: "mintSecretKey" });
    logger.info("Minting a previewkit secret key generation", { extra: { keyId } });

    const existing = await db.previewkitSecretKey.findUnique({ where: { id: keyId } });
    if (existing != null) {
        throw new Error(
            `Secret key generation "${keyId}" already exists. Key ids are permanent - ` +
                `every envelope sealed with one names it - so pick an unused id.`,
        );
    }

    const { material, wrapped } = await provider.generate(keyEncryptionContext(keyId));

    // Building the cipher validates the key id and the material length before
    // anything is committed, using the same rules that will apply when this
    // generation seals its first value. The plaintext is discarded here.
    const validated = new SecretCipher(keyId, material);

    await db.$transaction(async (tx) => {
        await tx.previewkitSecretKey.updateMany({ where: { primary: true }, data: { primary: false } });
        await tx.previewkitSecretKey.create({
            // Copied into its own buffer: a provider may hand back a view over a
            // pooled or shared buffer, which Prisma's Bytes column will not take.
            data: { id: validated.keyId, wrap: Uint8Array.from(wrapped), primary: true },
        });
    });

    logger.info("Secret key generation minted and promoted to primary", { extra: { keyId } });
}
