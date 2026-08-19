import { type SecretCipher, scopeFor } from "@autonoma/utils";
import { secretFingerprint } from "./secret-fingerprint";

/** How much of a value's length `maskedLength` will admit to, so long values do not leak their size. */
const MAX_MASKED_LENGTH = 32;

/** The sealed columns of one `previewkit_secret` row - everything but the key and the app it hangs off. */
export interface SealedSecretRow {
    envelope: string;
    encryptionKeyId: string;
    fingerprint: string;
    maskedLength: number;
}

/**
 * Seals one value into the columns a secret row stores.
 *
 * Two writers produce these: the value store, and the config operation applier
 * that seals inside its own transaction. A value written by one is read back
 * through the other, so the four fields have to be computed identically. Two
 * copies would diverge silently - a different masked length is not an error
 * anywhere, it just makes the same value look different depending on which path
 * happened to write it.
 */
export function sealedSecretRow(cipher: SecretCipher, appId: string, key: string, value: string): SealedSecretRow {
    return {
        envelope: cipher.encrypt(value, scopeFor(appId, key)),
        encryptionKeyId: cipher.keyId,
        fingerprint: secretFingerprint(value),
        maskedLength: Math.min(value.length, MAX_MASKED_LENGTH),
    };
}
