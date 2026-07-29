-- Drops `degraded` from previewkit_usage_window. It marked a window whose namespace
-- returned no samples, to tell "unmeasured" apart from "genuinely idle" - both record
-- 0/0 usage. Nothing consumed it: the alerting that once read it has moved to the
-- previewkit-metering rule group, which watches the CronJob rather than its output.
--
-- Consequence, deliberately accepted: a metrics gap now leaves no trace, so the
-- windows it under-billed cannot be identified afterwards.
--
-- IF EXISTS so a partially-applied attempt can re-run.

-- AlterTable
ALTER TABLE "previewkit_usage_window" DROP COLUMN IF EXISTS "degraded";
