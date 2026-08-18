import type { PrismaClient } from "@autonoma/db";
import { KMSClient } from "@aws-sdk/client-kms";
import { KmsKeyProvider } from "./kms-key-provider";
import { SecretKeys } from "./secret-keys";

const DEFAULT_REGION = "us-east-1";

export interface KmsSecretKeysParams {
    db: PrismaClient;
    /** The CMK the encryption keys are wrapped under. Without it nothing can be unwrapped. */
    cmk: string;
    /** Defaults to us-east-1 when unset, so a caller can pass `process.env.AWS_REGION` straight through. */
    region?: string | undefined;
}

/**
 * The standard KMS-backed {@link SecretKeys}, assembled in one place.
 *
 * Every caller that needs to open or seal a value builds the same three-object
 * stack, and each copy is a chance to point one of them somewhere subtly different -
 * a different region, another account's CMK - which surfaces only as values that
 * will not unwrap. Callers outside this package also have no business importing the
 * AWS SDK just to get here.
 */
export function createKmsSecretKeys({ db, cmk, region = DEFAULT_REGION }: KmsSecretKeysParams): SecretKeys {
    return new SecretKeys(db, new KmsKeyProvider(new KMSClient({ region }), cmk));
}
