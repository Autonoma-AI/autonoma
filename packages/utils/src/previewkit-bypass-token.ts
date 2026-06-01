import { EncryptionHelper } from "./encryption";

export function encryptPreviewkitBypassToken(raw: string, key: string | undefined): string {
    if (key == null) return raw;
    return new EncryptionHelper(key).encrypt(raw);
}

export function resolvePreviewkitBypassToken(stored: string, key: string | undefined): string {
    if (key == null) return stored;
    return new EncryptionHelper(key).decrypt(stored);
}
