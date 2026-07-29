import { ThirdPartyError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { DataKeySpec, DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import type { KeyProvider } from "./key-provider";

const PROVIDER = "AWS KMS";

/**
 * Mints and unwraps previewkit secret keys with AWS KMS.
 *
 * `cmkId` (a key id, ARN, or `alias/...`) is only needed to MINT - a symmetric
 * KMS ciphertext identifies its own key, so unwrapping names none. Which CMKs a
 * process may use is an IAM decision: give each environment its own CMK and
 * scope the role to it, so a beta pod handed a production key row fails with
 * AccessDenied rather than quietly decrypting it.
 */
export class KmsKeyProvider implements KeyProvider {
    private readonly logger: Logger;

    constructor(
        private readonly kms: KMSClient,
        private readonly cmkId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async generate(encryptionContext: Record<string, string>): Promise<{ material: Uint8Array; wrapped: Uint8Array }> {
        this.logger.info("Generating a secret key via KMS", { extra: { encryptionContext, cmkId: this.cmkId } });

        const response = await this.kms
            .send(
                new GenerateDataKeyCommand({
                    KeyId: this.cmkId,
                    KeySpec: DataKeySpec.AES_256,
                    EncryptionContext: encryptionContext,
                }),
            )
            .catch((err: unknown) => {
                throw new ThirdPartyError(PROVIDER, err, `KMS could not generate a secret key: ${describe(err)}`);
            });

        if (response.Plaintext == null || response.CiphertextBlob == null) {
            throw new ThirdPartyError(PROVIDER, undefined, "KMS returned an incomplete generated key.");
        }

        return { material: response.Plaintext, wrapped: response.CiphertextBlob };
    }

    async unwrap(wrapped: Uint8Array, encryptionContext: Record<string, string>): Promise<Uint8Array> {
        this.logger.debug("Unwrapping a secret key via KMS", { extra: { encryptionContext } });

        const response = await this.kms
            .send(new DecryptCommand({ CiphertextBlob: wrapped, EncryptionContext: encryptionContext }))
            .catch((err: unknown) => {
                throw new ThirdPartyError(PROVIDER, err, `KMS could not unwrap the secret key: ${describe(err)}`);
            });

        if (response.Plaintext == null) {
            throw new ThirdPartyError(PROVIDER, undefined, "KMS returned no plaintext for a key unwrap.");
        }
        return response.Plaintext;
    }
}

/**
 * KMS reports some failures with an unhelpful message - an encryption-context
 * mismatch arrives as "UnknownError" - so lead with the exception name, which is
 * what an operator can actually search for.
 */
function describe(err: unknown): string {
    if (!(err instanceof Error)) return String(err);

    const detail = err.message.length > 0 && err.message !== err.name ? `: ${err.message}` : "";
    return `${err.name}${detail}`;
}
