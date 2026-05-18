-- Scope PreviewkitSecret per-app within a (potentially monorepo) Application.
-- Was: one row per Application (`application_id` UNIQUE).
-- Now: one row per (Application, app), allowing distinct AWS Secrets Manager
--      ARNs for each app under a single repo with independent IAM boundaries.
--
-- Option-A migration: `app_name` lands NULLABLE here. A subsequent backfill
-- script populates it for existing rows, then a follow-up migration tightens
-- it to NOT NULL.

-- AlterTable: add the new column
ALTER TABLE "previewkit_secret" ADD COLUMN "app_name" TEXT;

-- DropIndex: remove the old single-column UNIQUE
DROP INDEX "previewkit_secret_application_id_key";

-- CreateIndex: composite UNIQUE on (application, app)
CREATE UNIQUE INDEX "previewkit_secret_application_id_app_name_key" ON "previewkit_secret"("application_id", "app_name");

-- CreateIndex: keep an index on application_id since we still query by it (findMany)
CREATE INDEX "previewkit_secret_application_id_idx" ON "previewkit_secret"("application_id");
