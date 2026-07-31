import type { PrismaClient } from "@autonoma/db";
import { KmsKeyProvider, SecretKeys, SecretValues } from "@autonoma/secrets";
import { KMSClient } from "@aws-sdk/client-kms";
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
    if (env.PREVIEWKIT_SECRETS_CMK == null) return undefined;

    const kms = new KMSClient({ region: env.AWS_REGION ?? "us-east-1" });
    return new SecretValues(conn, new SecretKeys(conn, new KmsKeyProvider(kms, env.PREVIEWKIT_SECRETS_CMK)));
}
