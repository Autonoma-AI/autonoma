import type { SecretTargetRecord } from "./dedupe-secret-targets";

/**
 * What the deployer needs to wire an app to its runtime secret: the K8s Secret
 * name (mounted via `envFrom`) and that Secret's resourceVersion at deploy time.
 * The version is stamped onto the app's pod template so a secret change rolls the
 * pods - `envFrom` is captured at pod start, so a running pod never picks up a
 * later secret update on its own.
 */
export interface AppSecretInfo {
    secretName: string;
    secretVersion: string;
}

/** One secret row and the K8s Secret it materializes into, after target dedupe. */
export interface SecretTarget {
    record: SecretTargetRecord;
    secretName: string;
}
