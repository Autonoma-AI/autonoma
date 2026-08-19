-- Drops the two columns a secret row no longer identifies itself by. `app_id` and
-- `key` have been its unique key since the previous migration, and both of these
-- are derivable from the app row - verified against production before the drop:
-- no row's `app_name` disagreed with its app's name, and none's `application_id`
-- disagreed with its app's config.
--
-- Apply this only once no running pod still names either column. Nothing has
-- written them since the previous release, so the values here are already stale
-- for anything written after it.
DROP INDEX "previewkit_secret_application_id_app_name_key_key";
DROP INDEX "previewkit_secret_application_id_idx";

ALTER TABLE "previewkit_secret" DROP CONSTRAINT "previewkit_secret_application_id_fkey";

ALTER TABLE "previewkit_secret" DROP COLUMN "application_id";
ALTER TABLE "previewkit_secret" DROP COLUMN "app_name";
