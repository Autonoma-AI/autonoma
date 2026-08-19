import type { PrismaClient } from "@autonoma/db";
import { createKmsSecretKeys, type SecretKeys, SecretValues } from "@autonoma/secrets";
import { env } from "../env";

/**
 * The store for previewkit secret values, or undefined when this environment has no
 * CMK to unwrap an encryption key with (dev, self-host).
 *
 * A single factory on purpose. It used to be built inside `buildServices`, while the
 * native `/v1/previewkit/secrets` router constructed its own service with no store
 * at all - so every secret written through that public surface skipped Postgres
 * entirely. Both paths now come through here, which is the only way the two cannot
 * drift again.
 *
 * `PREVIEWKIT_SECRETS_CMK` is the marker that an environment is provisioned;
 * unwrapping itself never names the CMK, because a symmetric KMS ciphertext
 * identifies its own key.
 */
export function buildSecretValues(conn: PrismaClient): SecretValues | undefined {
    const keys = buildSecretKeys(conn);
    return keys == null ? undefined : new SecretValues(conn, keys);
}

/**
 * The key resolver behind the store, for callers that seal on their own schedule -
 * the config operation applier seals inside its transaction, so it needs the keys
 * rather than the store built over them.
 */
export function buildSecretKeys(conn: PrismaClient): SecretKeys | undefined {
    if (env.PREVIEWKIT_SECRETS_CMK == null) return undefined;
    return createKmsSecretKeys({ db: conn, cmk: env.PREVIEWKIT_SECRETS_CMK, region: env.AWS_REGION });
}
