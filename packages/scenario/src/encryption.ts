import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function toUint8Array(buf: Buffer): Uint8Array {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class EncryptionHelper {
    private readonly key: Uint8Array;

    constructor(masterKeyHex: string) {
        const key = Buffer.from(masterKeyHex, "hex");
        if (key.length < 32) {
            throw new Error("SCENARIO_ENCRYPTION_KEY must be at least 64 hex characters (32 bytes)");
        }
        this.key = toUint8Array(key.subarray(0, 32));
    }

    encrypt(plaintext: string): string {
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv(ALGORITHM, this.key, toUint8Array(iv), { authTagLength: AUTH_TAG_LENGTH });

        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()].map(toUint8Array));
        const authTag = cipher.getAuthTag();

        return Buffer.concat([iv, encrypted, authTag].map(toUint8Array)).toString("base64");
    }

    decrypt(encrypted: string): string {
        const data = Buffer.from(encrypted, "base64");

        const iv = data.subarray(0, IV_LENGTH);
        const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
        const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

        const decipher = createDecipheriv(ALGORITHM, this.key, toUint8Array(iv), { authTagLength: AUTH_TAG_LENGTH });
        decipher.setAuthTag(toUint8Array(authTag));

        return Buffer.concat([decipher.update(toUint8Array(ciphertext)), decipher.final()].map(toUint8Array)).toString(
            "utf8",
        );
    }
}
