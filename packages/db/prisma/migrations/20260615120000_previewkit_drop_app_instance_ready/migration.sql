-- The deploy-time `ready` flag on previewkit_app_instance is now subsumed by
-- `status` (an app is ready iff status = 'ready') and has no remaining reader,
-- so drop it.

-- AlterTable
ALTER TABLE "previewkit_app_instance" DROP COLUMN "ready";
