const PURPOSE = "previewkit-secrets";

/**
 * The additional authenticated data a key generation is wrapped under. Minting
 * and unwrapping must produce the identical context or the unwrap fails, so both
 * sides come from here: it binds a wrapped key to its key id, and providers that
 * log the context make each unwrap traceable to the generation it was for.
 */
export function keyEncryptionContext(keyId: string): Record<string, string> {
    return { purpose: PURPOSE, keyId };
}
