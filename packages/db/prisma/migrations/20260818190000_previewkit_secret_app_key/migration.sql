-- The identity of a secret row moves from (application_id, app_name, key) to
-- (app_id, key). Both are equivalent today - app_id was backfilled from the pair
-- and every row agrees with its app - so this adds the new key without touching
-- a value.
--
-- Apply this BEFORE deploying the code that stops writing the two columns.
-- They are NOT NULL right now, so a writer that omits them fails until this
-- runs; old writers that still fill them in keep working after it. The columns
-- themselves come off in a later migration, once no running pod names them.
CREATE UNIQUE INDEX "previewkit_secret_app_id_key_key" ON "previewkit_secret"("app_id", "key");

-- Redundant now: the unique index above serves any lookup by app_id alone.
DROP INDEX "previewkit_secret_app_id_idx";

ALTER TABLE "previewkit_secret" ALTER COLUMN "application_id" DROP NOT NULL;
ALTER TABLE "previewkit_secret" ALTER COLUMN "app_name" DROP NOT NULL;
