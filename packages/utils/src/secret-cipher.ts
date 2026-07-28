import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { toUint8Array } from "./to-uint8-array";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_BYTE_LENGTH = 32;

/** Ciphertext envelope: `<version>.<keyId>.<base64(iv || ciphertext || tag)>`. Base64 never contains `.`. */
const FORMAT_VERSION = "v1";
const FIELD_SEPARATOR = ".";
const FIELD_COUNT = 3;

/** Key ids are stamped into envelopes, so they must not contain the field separator. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The row a secret value belongs to. Encoded into the AES-GCM additional
 * authenticated data, so a ciphertext only ever decrypts in the exact row it was
 * written for: someone with write access to the database cannot move another
 * tenant's ciphertext into their own row and read it back through the API.
 */
export type SecretScope =
    | { kind: "app"; applicationId: string; appName: string; key: string }
    | { kind: "org"; organizationId: string; name: string; key: string };

/**
 * Reads the key id an envelope was sealed under, without needing the key. This
 * is how a caller knows which key generation to fetch and unwrap before it can
 * decrypt (see `SecretKeys` in `@autonoma/secrets`).
 */
export function readEnvelopeKeyId(ciphertext: string): string {
    return parseEnvelope(ciphertext).keyId;
}

/**
 * AES-256-GCM over previewkit secret values, holding exactly one key generation.
 * The envelope names that generation, so stored values stay readable across a
 * key rotation: resolve the cipher for an envelope's key id, rather than
 * expecting one process-wide key to open everything.
 *
 * Distinct from `EncryptionHelper`, which stays as-is because its bare base64
 * envelope is already written into columns across the schema (Vercel access
 * tokens, scenario signing secrets, preview bypass tokens) and names no key.
 */
export class SecretCipher {
    private readonly material: Uint8Array;

    /**
     * @param keyId identifies this generation; stamped into every envelope.
     * @param material exactly 32 bytes of key material.
     */
    constructor(
        readonly keyId: string,
        material: Uint8Array,
    ) {
        if (!KEY_ID_PATTERN.test(keyId)) {
            throw new Error(`Malformed secret key id "${keyId}": expected one or more of A-Z, a-z, 0-9, _ or -.`);
        }
        if (material.length !== KEY_BYTE_LENGTH) {
            throw new Error(
                `Malformed material for secret key id "${keyId}": expected ${KEY_BYTE_LENGTH} bytes, got ${material.length}.`,
            );
        }
        this.material = material;
    }

    encrypt(plaintext: string, scope: SecretScope): string {
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv(ALGORITHM, this.material, toUint8Array(iv), {
            authTagLength: AUTH_TAG_LENGTH,
        });
        cipher.setAAD(scopeAad(scope));

        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()].map(toUint8Array));
        const payload = Buffer.concat([iv, encrypted, cipher.getAuthTag()].map(toUint8Array)).toString("base64");

        return [FORMAT_VERSION, this.keyId, payload].join(FIELD_SEPARATOR);
    }

    /**
     * Throws when the envelope is malformed, when it names a different key
     * generation than this cipher holds, or when the GCM tag fails - which
     * covers both a tampered ciphertext and a `scope` that does not match the
     * one it was sealed under.
     */
    decrypt(ciphertext: string, scope: SecretScope): string {
        const { keyId, payload } = parseEnvelope(ciphertext);

        if (keyId !== this.keyId) {
            throw new Error(
                `Cannot decrypt a secret sealed with key id "${keyId}" using key id "${this.keyId}". ` +
                    `Resolve the cipher for the envelope's key id first.`,
            );
        }

        const data = Buffer.from(payload, "base64");
        if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
            throw new Error(`Cannot decrypt secret sealed with key id "${keyId}": the envelope payload is truncated.`);
        }

        const iv = data.subarray(0, IV_LENGTH);
        const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
        const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

        const decipher = createDecipheriv(ALGORITHM, this.material, toUint8Array(iv), {
            authTagLength: AUTH_TAG_LENGTH,
        });
        decipher.setAAD(scopeAad(scope));
        decipher.setAuthTag(toUint8Array(authTag));

        return Buffer.concat([decipher.update(toUint8Array(encrypted)), decipher.final()].map(toUint8Array)).toString(
            "utf8",
        );
    }
}

/**
 * The scope as authenticated data. JSON-encodes a fixed-order tuple rather than
 * joining on a separator so that user-controlled segments cannot be re-cut into
 * a different scope with the same encoding - `appName: "a:b", key: "c"` and
 * `appName: "a", key: "b:c"` must not produce the same AAD.
 */
function scopeAad(scope: SecretScope): Uint8Array {
    const fields =
        scope.kind === "app"
            ? [scope.kind, scope.applicationId, scope.appName, scope.key]
            : [scope.kind, scope.organizationId, scope.name, scope.key];

    return new TextEncoder().encode(JSON.stringify(["previewkit-secret", FORMAT_VERSION, ...fields]));
}

function parseEnvelope(ciphertext: string): { keyId: string; payload: string } {
    const fields = ciphertext.split(FIELD_SEPARATOR);
    const [version, keyId, payload] = fields;

    if (fields.length !== FIELD_COUNT || version !== FORMAT_VERSION || keyId == null || payload == null) {
        throw new Error(
            `Unrecognized secret envelope: expected "${FORMAT_VERSION}${FIELD_SEPARATOR}<keyId>${FIELD_SEPARATOR}<base64>".`,
        );
    }
    return { keyId, payload };
}
