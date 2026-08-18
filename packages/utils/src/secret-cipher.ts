import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { toUint8Array } from "./to-uint8-array";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_BYTE_LENGTH = 32;

/** Ciphertext envelope: `<version>.<keyId>.<base64(iv || ciphertext || tag)>`. Base64 never contains `.`. */
const FIELD_SEPARATOR = ".";
const FIELD_COUNT = 3;

/**
 * The scope an envelope's authenticated data is built from, and the reason the
 * version lives in the envelope at all.
 *
 * - `v1` binds `(applicationId, appName, key)`. An app's NAME is therefore part of
 *   the ciphertext's identity, which is why renaming one has always cost its values.
 * - `v2` binds `(appId, key)`. The row id survives a rename, so the value does too.
 *
 * Sealing uses {@link SEALED_VERSION}; opening accepts either, so the fleet can move
 * across the change without a flag day and without a window where a value written by
 * one pod cannot be read by another.
 */
const V1 = "v1";
const V2 = "v2";
const READABLE_VERSIONS: ReadonlySet<string> = new Set([V1, V2]);

/** The version new envelopes are sealed under. v1 stays readable until every stored envelope has been re-sealed. */
const SEALED_VERSION = V2;

/** Key ids are stamped into envelopes, so they must not contain the field separator. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The row a secret value belongs to. Encoded into the AES-GCM additional
 * authenticated data, so a ciphertext only ever decrypts in the exact row it was
 * written for: someone with write access to the database cannot move another
 * tenant's ciphertext into their own row and read it back through the API.
 */
export interface SecretScope {
    kind: "app";
    applicationId: string;
    appName: string;
    key: string;
    /**
     * The app row this value hangs off. Absent on rows written before the column
     * existed; required to open a `v2` envelope, which is bound to it rather than
     * to the application and name.
     */
    appId?: string;
}

/**
 * The bundle a secret value lives in - a {@link SecretScope} without the key.
 * Callers hold one of these per bundle and derive a scope per value with
 * {@link scopeIn}, so the authenticated data is assembled in one place rather
 * than spelled out at each call site where a field could quietly be missed.
 */
export interface SecretBundle {
    kind: "app";
    applicationId: string;
    appName: string;
    /** See {@link SecretScope.appId}. */
    appId?: string;
}

export function scopeIn(bundle: SecretBundle, key: string): SecretScope {
    return {
        kind: "app",
        applicationId: bundle.applicationId,
        appName: bundle.appName,
        appId: bundle.appId,
        key,
    };
}

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

    private readonly sealVersion: string;

    /**
     * @param keyId identifies this generation; stamped into every envelope.
     * @param material exactly 32 bytes of key material.
     * @param sealVersion which envelope version to WRITE. Defaults to the current
     *   one; overridable only because a version migration needs to be able to
     *   produce the old shape - to prove the old shape still opens, and to write it
     *   again if the new one has to be rolled back. Reading always accepts both.
     */
    constructor(
        readonly keyId: string,
        material: Uint8Array,
        sealVersion: string = SEALED_VERSION,
    ) {
        if (!READABLE_VERSIONS.has(sealVersion)) {
            throw new Error(`Cannot seal envelopes as unknown version "${sealVersion}".`);
        }
        this.sealVersion = sealVersion;
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
        cipher.setAAD(scopeAad(scope, this.sealVersion));

        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()].map(toUint8Array));
        const payload = Buffer.concat([iv, encrypted, cipher.getAuthTag()].map(toUint8Array)).toString("base64");

        return [this.sealVersion, this.keyId, payload].join(FIELD_SEPARATOR);
    }

    /**
     * Throws when the envelope is malformed, when it names a different key
     * generation than this cipher holds, or when the GCM tag fails - which
     * covers both a tampered ciphertext and a `scope` that does not match the
     * one it was sealed under.
     */
    decrypt(ciphertext: string, scope: SecretScope): string {
        const { version, keyId, payload } = parseEnvelope(ciphertext);

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
        decipher.setAAD(scopeAad(scope, version));
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
function scopeAad(scope: SecretScope, version: string): Uint8Array {
    if (version === V2) {
        if (scope.appId == null) {
            throw new Error(
                "Cannot build v2 authenticated data without an appId: the envelope is bound to the app row, " +
                    "so the scope has to name it.",
            );
        }
        return encodeAad([V2, scope.kind, scope.appId, scope.key]);
    }
    return encodeAad([V1, scope.kind, scope.applicationId, scope.appName, scope.key]);
}

function encodeAad(fields: readonly string[]): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(["previewkit-secret", ...fields]));
}

function parseEnvelope(ciphertext: string): { version: string; keyId: string; payload: string } {
    const fields = ciphertext.split(FIELD_SEPARATOR);
    const [version, keyId, payload] = fields;

    if (fields.length !== FIELD_COUNT || version == null || !READABLE_VERSIONS.has(version)) {
        throw new Error(
            `Unrecognized secret envelope: expected "<${[...READABLE_VERSIONS].join("|")}>` +
                `${FIELD_SEPARATOR}<keyId>${FIELD_SEPARATOR}<base64>".`,
        );
    }
    if (keyId == null || payload == null) {
        throw new Error("Unrecognized secret envelope: missing key id or payload.");
    }
    return { version, keyId, payload };
}
