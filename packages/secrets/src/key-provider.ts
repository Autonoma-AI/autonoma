/**
 * The two key-management operations previewkit secrets need. Kept as a seam so
 * tests and non-AWS hosts can supply their own without a KMS client.
 *
 * `encryptionContext` is additional authenticated data: a blob generated under
 * one context only unwraps under the same one, so one key's wrapped blob cannot
 * be passed off as another's. Providers that log it (KMS does, via CloudTrail)
 * also make each unwrap traceable to the key id it was for.
 */
export interface KeyProvider {
    /** Mints new key material and returns it alongside its wrapped form. Only the wrapped form is ever stored. */
    generate(encryptionContext: Record<string, string>): Promise<{ material: Uint8Array; wrapped: Uint8Array }>;

    unwrap(wrapped: Uint8Array, encryptionContext: Record<string, string>): Promise<Uint8Array>;
}
