-- Drop previewkit_secret.k8s_secret_name.
--
-- The column was historical-stability insurance for the K8s Secret name that
-- ExternalSecretsOperator materialises in the preview namespace. With
-- per-app secrets, the K8s name is fully derivable from `app_name` (it's
-- always `<app_name>-secrets`, sanitized), and the previewkit code now
-- computes it locally inside AwsExternalSecretManager.toK8sName(). No need
-- to persist it.
--
-- Safe to apply: the previewkit code change that stops reading this column
-- must ship first. After that, the column is unread and can be dropped.

ALTER TABLE "previewkit_secret" DROP COLUMN "k8s_secret_name";
