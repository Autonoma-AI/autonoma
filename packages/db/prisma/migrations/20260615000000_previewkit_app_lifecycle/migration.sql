-- Per-app lifecycle status on previewkit_app_instance.
--
-- Evolves the table from "only the apps that deployed and became ready" into
-- the per-app lifecycle record: a row exists for every configured app from
-- moment 0 (status 'pending') and is transitioned through build + deploy, so a
-- built-but-undeployed app (e.g. one that failed readiness while its siblings
-- came up) is a distinct, queryable row rather than an inferred absence.

-- CreateEnum
CREATE TYPE "previewkit_app_status" AS ENUM ('pending', 'building', 'built', 'deploying', 'ready', 'build_failed', 'deploy_failed', 'skipped');

-- AlterTable
-- image_tag is now null until the build succeeds; status + error track the
-- full lifecycle and the reason for a build_failed / deploy_failed outcome.
ALTER TABLE "previewkit_app_instance"
    ADD COLUMN     "status" "previewkit_app_status" NOT NULL DEFAULT 'pending',
    ADD COLUMN     "error" TEXT,
    ALTER COLUMN "image_tag" DROP NOT NULL;

-- Existing rows were only ever written for apps that deployed and became
-- ready, so backfill them to 'ready' rather than the 'pending' column default.
UPDATE "previewkit_app_instance" SET "status" = 'ready';
