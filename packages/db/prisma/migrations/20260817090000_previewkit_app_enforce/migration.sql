-- Enforces the app foreign keys. THIS MIGRATION DELETES DATA.
--
-- Backfills first, deletes what still cannot be matched, then enforces. Doing the
-- backfill here rather than trusting the script means the enforcement cannot run
-- against rows written between the script and this deploy - release 1 added the
-- column but its writers never populated it, so that window is real.

-- 1. Stamp anything the script has not. Same joins, so re-running it is a no-op.
UPDATE "previewkit_secret" s
   SET "app_id" = a."id"
  FROM "previewkit_app" a
  JOIN "previewkit_config" c ON c."id" = a."config_id"
 WHERE s."app_id" IS NULL
   AND c."application_id" = s."application_id"
   AND a."name" = s."app_name";

UPDATE "previewkit_app_instance" i
   SET "app_id" = a."id"
  FROM "previewkit_environment" e
  JOIN "application" app ON app."github_repository_id" = e."github_repository_id"
  JOIN "previewkit_config" c ON c."application_id" = app."id"
  JOIN "previewkit_app" a ON a."config_id" = c."id"
 WHERE i."app_id" IS NULL
   AND e."id" = i."environment_id"
   AND a."name" = i."app_name";

UPDATE "previewkit_app_build" ab
   SET "app_id" = a."id"
  FROM "previewkit_build" b
  JOIN "previewkit_environment" e ON e."id" = b."environment_id"
  JOIN "application" app ON app."github_repository_id" = e."github_repository_id"
  JOIN "previewkit_config" c ON c."application_id" = app."id"
  JOIN "previewkit_app" a ON a."config_id" = c."id"
 WHERE ab."app_id" IS NULL
   AND b."id" = ab."build_id"
   AND a."name" = ab."app_name";

-- 2. Delete what names an app no topology has. These are deploy records for apps
-- that were renamed or removed, and secret values whose app is gone. Deliberate and
-- irreversible: the design chose a hard foreign key, which makes them unrepresentable.
-- Some instance rows belong to environments that are still live; those previews read
-- as app-less until they redeploy against a topology that contains those apps.
DELETE FROM "previewkit_app_build" WHERE "app_id" IS NULL;
DELETE FROM "previewkit_app_instance" WHERE "app_id" IS NULL;
DELETE FROM "previewkit_secret" WHERE "app_id" IS NULL;

-- 3. Enforce. NOT NULL and CASCADE land together: from here an app row is the only
-- place these can hang, and deleting one takes its secrets, instances and builds.
ALTER TABLE "previewkit_secret" ALTER COLUMN "app_id" SET NOT NULL;
ALTER TABLE "previewkit_app_instance" ALTER COLUMN "app_id" SET NOT NULL;
ALTER TABLE "previewkit_app_build" ALTER COLUMN "app_id" SET NOT NULL;

ALTER TABLE "previewkit_secret" DROP CONSTRAINT "previewkit_secret_app_id_fkey";
ALTER TABLE "previewkit_secret" ADD CONSTRAINT "previewkit_secret_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "previewkit_app_instance" DROP CONSTRAINT "previewkit_app_instance_app_id_fkey";
ALTER TABLE "previewkit_app_instance" ADD CONSTRAINT "previewkit_app_instance_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "previewkit_app_build" DROP CONSTRAINT "previewkit_app_build_app_id_fkey";
ALTER TABLE "previewkit_app_build" ADD CONSTRAINT "previewkit_app_build_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;
