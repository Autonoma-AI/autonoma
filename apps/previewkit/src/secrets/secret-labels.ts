/**
 * The labels on a preview's runtime secret objects, shared by both materializers.
 *
 * They are the handoff contract: `PostgresSecretMaterializer` stamps
 * `SECRET_TYPE` on a Secret it writes, and `AwsExternalSecretManager` reads that
 * same key to tell a Secret it may delete and recreate from an ESO-owned or
 * foreign one it must not touch. A key spelled differently in either place makes
 * the handoff silently stop working, so there is one definition.
 *
 * `previewkit.dev/managed-by` is stamped far more widely than this (workloads,
 * recipes, hooks); this module deliberately covers only the secret objects rather
 * than trying to unify that.
 */
export const SECRET_LABEL = {
    managedBy: "previewkit.dev/managed-by",
    type: "previewkit.dev/type",
    org: "previewkit.dev/org",
} as const;

export const MANAGED_BY_PREVIEWKIT = "previewkit";

/** `SECRET_LABEL.type` on the ExternalSecret CRs this app owns. */
export const EXTERNAL_SECRET_TYPE = "aws-external-secret";

/**
 * `SECRET_LABEL.type` on a K8s Secret written straight from Postgres, which is
 * how a Postgres-written target is told apart from an ESO-owned one.
 */
export const POSTGRES_SECRET_TYPE = "app-secret";
