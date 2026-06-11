-- AlterEnum
-- New terminal status for a build whose deploy was cancelled by a newer commit.
ALTER TYPE "previewkit_status" ADD VALUE 'superseded';

-- Dedupe existing build rows before adding the unique constraint.
-- recordBuildFinished used a plain create() with no dedup key, so a Temporal
-- activity retry could insert duplicate rows for the same (environment, sha).
-- Keep the newest startedAt (id as tiebreaker); PreviewkitAppBuild rows cascade.
DELETE FROM "previewkit_build"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("environment_id", "head_sha") "id"
  FROM "previewkit_build"
  ORDER BY "environment_id", "head_sha", "started_at" DESC, "id" DESC
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_build_environment_id_head_sha_key" ON "previewkit_build"("environment_id", "head_sha");
