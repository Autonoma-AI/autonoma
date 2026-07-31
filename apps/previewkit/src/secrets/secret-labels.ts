/**
 * The labels on a preview's runtime secret objects.
 *
 * `PostgresSecretMaterializer` stamps `POSTGRES_SECRET_TYPE` on every Secret it
 * writes, and `ExternalSecretRelease` selects on `EXTERNAL_SECRET_TYPE` to find the
 * ExternalSecrets left over from before the cutover. A key spelled differently in
 * either place makes the release silently stop finding them, so there is one
 * definition.
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

/**
 * `SECRET_LABEL.type` on the ExternalSecret CRs previewkit used to create. Nothing
 * stamps this any more; it is how the release finds the ones still owning a Secret.
 */
export const EXTERNAL_SECRET_TYPE = "aws-external-secret";

/** `SECRET_LABEL.type` on a K8s Secret previewkit writes from the database. */
export const POSTGRES_SECRET_TYPE = "app-secret";
