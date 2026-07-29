/**
 * No encryption key has been minted yet, so nothing can be sealed.
 *
 * Typed rather than a bare Error because callers need to tell it apart from a
 * real failure: during the migration to database-stored secrets it means "this
 * environment has not run `mintSecretKey` yet", which is expected and skippable,
 * whereas an unwrap or persistence failure is not.
 */
export class NoPrimaryEncryptionKeyError extends Error {
    constructor() {
        super("No primary previewkit encryption key exists. " + "Mint one with mintSecretKey before writing secrets.");
        this.name = "NoPrimaryEncryptionKeyError";
    }
}
