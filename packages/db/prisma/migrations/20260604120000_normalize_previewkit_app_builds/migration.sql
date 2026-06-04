-- Normalize the `previewkit_build.app_builds` JSON column into a dedicated
-- `previewkit_app_build` child table (one row per app per build). The DDL below
-- is Prisma-generated; the backfill INSERT is added by hand and Prisma's
-- `DROP COLUMN` is moved to the end so the existing JSON data can be copied into
-- the new table before the column is removed.

-- CreateEnum
CREATE TYPE "previewkit_app_build_status" AS ENUM ('ok', 'failed');

-- CreateTable
CREATE TABLE "previewkit_app_build" (
    "id" TEXT NOT NULL,
    "build_id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "status" "previewkit_app_build_status" NOT NULL,
    "image_tag" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "log_url" TEXT,
    "error" TEXT,
    "runtime" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previewkit_app_build_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_app_build_build_id_app_name_key" ON "previewkit_app_build"("build_id", "app_name");

-- AddForeignKey
ALTER TABLE "previewkit_app_build" ADD CONSTRAINT "previewkit_app_build_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "previewkit_build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: expand each build's `app_builds` JSON map into one row per app.
-- Skip entries whose status is neither 'ok' nor 'failed' so the enum cast never
-- fails. `duration_ms` defaults to 0 when missing, mirroring the old reader's
-- coercion.
INSERT INTO "previewkit_app_build" (
    "id",
    "build_id",
    "app_name",
    "status",
    "image_tag",
    "duration_ms",
    "log_url",
    "error",
    "runtime",
    "created_at"
)
SELECT
    gen_random_uuid()::text,
    b."id",
    kv.key,
    (kv.value->>'status')::"previewkit_app_build_status",
    kv.value->>'imageTag',
    COALESCE((kv.value->>'durationMs')::int, 0),
    kv.value->>'logUrl',
    kv.value->>'error',
    kv.value->>'runtime',
    b."started_at"
FROM "previewkit_build" b, jsonb_each(b."app_builds") AS kv
WHERE jsonb_typeof(b."app_builds") = 'object'
  AND kv.value->>'status' IN ('ok', 'failed');

-- DropColumn (moved after the backfill above so the JSON can still be read).
ALTER TABLE "previewkit_build" DROP COLUMN "app_builds";
