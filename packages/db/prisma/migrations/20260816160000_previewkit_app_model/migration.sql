-- Renames in place rather than dropping and recreating: the existing app ids are
-- what the secret/instance/build backfill stamps onto its rows, so losing them
-- would re-seal values against the wrong apps.
ALTER TABLE "previewkit_config_app" RENAME TO "previewkit_app";

-- Constraints and indexes keep their old names through a table rename, which
-- leaves them describing a table that no longer exists. Rename them to match so
-- Prisma's expected schema and the database agree.
ALTER TABLE "previewkit_app" RENAME CONSTRAINT "previewkit_config_app_pkey" TO "previewkit_app_pkey";
ALTER TABLE "previewkit_app" RENAME CONSTRAINT "previewkit_config_app_config_id_fkey" TO "previewkit_app_config_id_fkey";
ALTER INDEX "previewkit_config_app_config_id_idx" RENAME TO "previewkit_app_config_id_idx";
ALTER INDEX "previewkit_config_app_config_id_name_key" RENAME TO "previewkit_app_config_id_name_key";
ALTER INDEX "previewkit_config_app_config_id_position_key" RENAME TO "previewkit_app_config_id_position_key";

-- Nullable for now. Old pods still write these rows without an app id, and the
-- backfill has to run before the column can be enforced; release 2 sets NOT NULL.
--
-- SET NULL, not CASCADE, until then: while the column is nullable a deleted app
-- should detach its rows, not destroy them. A rename is still delete-plus-create
-- at this stage, so a cascade here would start eating secrets three releases
-- before the operations API can express a rename losslessly. Release 2 switches
-- these to CASCADE at the same moment it enforces NOT NULL.
ALTER TABLE "previewkit_secret" ADD COLUMN "app_id" TEXT;
ALTER TABLE "previewkit_app_instance" ADD COLUMN "app_id" TEXT;
ALTER TABLE "previewkit_app_build" ADD COLUMN "app_id" TEXT;

CREATE INDEX "previewkit_secret_app_id_idx" ON "previewkit_secret"("app_id");
CREATE INDEX "previewkit_app_instance_app_id_idx" ON "previewkit_app_instance"("app_id");
CREATE INDEX "previewkit_app_build_app_id_idx" ON "previewkit_app_build"("app_id");

ALTER TABLE "previewkit_secret" ADD CONSTRAINT "previewkit_secret_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "previewkit_app_instance" ADD CONSTRAINT "previewkit_app_instance_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "previewkit_app_build" ADD CONSTRAINT "previewkit_app_build_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "previewkit_app"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Dropped so a reorder is expressible. Apps are now diffed rather than replaced,
-- and swapping two apps' positions updates them one at a time - which trips a
-- unique constraint that Postgres checks per statement. Position only has to
-- order, and the writer always assigns it from the array index.
-- A Prisma @@unique is a plain unique index here, not a table constraint.
DROP INDEX "previewkit_app_config_id_position_key";
CREATE INDEX "previewkit_app_config_id_position_idx" ON "previewkit_app"("config_id", "position");
