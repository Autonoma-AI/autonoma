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

/**
 * Materializes the K8s Secret an app's pods mount, from whichever store holds the
 * values.
 *
 * Every implementation must return only once each Secret is actually populated:
 * the deployer rolls out app pods immediately afterwards, and a pod that boots
 * against a missing or stale Secret comes up "ready" with a bad
 * `AUTONOMA_SHARED_SECRET`, failing every signed SDK call until someone
 * redeploys by hand. Failing the deploy is the correct outcome; returning early
 * is not.
 */
export interface RuntimeSecretMaterializer {
    /** Keyed by appName. Apps whose Secret this store cannot supply are absent. */
    materialize(
        namespace: string,
        organizationId: string,
        targets: SecretTarget[],
    ): Promise<Map<string, AppSecretInfo>>;
}
