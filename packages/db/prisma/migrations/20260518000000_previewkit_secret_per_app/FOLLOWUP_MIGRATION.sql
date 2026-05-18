-- Tighten previewkit_secret.app_name to NOT NULL after the one-shot backfill.
--
-- DO NOT apply this migration until every previewkit_secret row has its
-- `app_name` populated. The previous migration (`previewkit_secret_per_app`)
-- left this column nullable so existing rows could be backfilled without
-- downtime; this one enforces the contract that every secret is scoped to
-- a specific app inside its (potentially monorepo) Application.
--
-- Pre-flight: confirm no NULLs remain.
--   SELECT count(*) FROM previewkit_secret WHERE app_name IS NULL;
--   -- expect 0
--
-- If the above returns > 0, run BACKFILL.sql from the previous migration first.

ALTER TABLE "previewkit_secret" ALTER COLUMN "app_name" SET NOT NULL;
