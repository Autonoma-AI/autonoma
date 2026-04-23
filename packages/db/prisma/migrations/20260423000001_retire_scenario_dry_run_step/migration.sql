-- Backfill any existing rows that were stuck on the old `scenario_dry_run`
-- value onto the new discovery lifecycle, then recreate the enum without it.
-- Rules:
--   - scenarios exist for the app -> `discovered`
--   - else webhook URL + signing secret are both set -> `webhook_configuring`
--   - else -> `working`

UPDATE "onboarding_state" os
SET "step" = 'discovered'
WHERE os."step" = 'scenario_dry_run'
  AND EXISTS (
    SELECT 1 FROM "scenario" s WHERE s."application_id" = os."application_id"
  );

UPDATE "onboarding_state" os
SET "step" = 'webhook_configuring'
WHERE os."step" = 'scenario_dry_run'
  AND EXISTS (
    SELECT 1
    FROM "application" a
    JOIN "branch" b ON b."id" = a."main_branch_id"
    JOIN "branch_deployment" bd ON bd."id" = b."deployment_id"
    WHERE a."id" = os."application_id"
      AND a."signing_secret_enc" IS NOT NULL
      AND bd."webhook_url" IS NOT NULL
  );

UPDATE "onboarding_state"
SET "step" = 'working'
WHERE "step" = 'scenario_dry_run';

-- Recreate the enum without `scenario_dry_run`. Safe now that no rows reference it.
DROP TYPE IF EXISTS "onboarding_step_new";
CREATE TYPE "onboarding_step_new" AS ENUM (
  'install',
  'configure',
  'working',
  'webhook_configuring',
  'discovering',
  'discovered',
  'dry_run_passed',
  'url',
  'github',
  'completed'
);

ALTER TABLE "onboarding_state"
  ALTER COLUMN "step" DROP DEFAULT,
  ALTER COLUMN "step" TYPE "onboarding_step_new" USING "step"::text::"onboarding_step_new",
  ALTER COLUMN "step" SET DEFAULT 'install';

DROP TYPE "onboarding_step";
ALTER TYPE "onboarding_step_new" RENAME TO "onboarding_step";
