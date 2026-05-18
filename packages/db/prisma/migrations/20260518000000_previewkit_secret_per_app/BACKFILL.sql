-- One-shot backfill for the per-app PreviewkitSecret migration.
--
-- After the schema migration (`20260518000000_previewkit_secret_per_app`)
-- lands, every existing row has `app_name = NULL`. Ops must populate the
-- value for each existing row before the follow-up migration tightens the
-- column to NOT NULL.
--
-- This file is NOT applied automatically by Prisma — it's a template to
-- copy/edit/run manually against each environment's database.
--
-- For each existing row, decide which app inside the (potentially monorepo)
-- Application the secret belongs to and update accordingly.

-- Example: a single-app repo where the existing secret applies to "web":
--   UPDATE previewkit_secret
--   SET app_name = 'web'
--   WHERE application_id = '<application-id>' AND app_name IS NULL;

-- Example: a monorepo with a single existing secret that should be split
-- into multiple AWS SM ARNs. Run for each app:
--   1. Create one new AWS SM secret per app with the appropriate keys
--   2. INSERT a row per app pointing at its new ARN
--   3. DELETE the old row (or UPDATE it to point at the new ARN for one app)

-- Inspection: rows still needing backfill
SELECT id, application_id, aws_secret_arn, k8s_secret_name
FROM previewkit_secret
WHERE app_name IS NULL;
