-- CreateEnum
CREATE TYPE "onboarding_step" AS ENUM ('install', 'configure', 'working', 'url', 'scenario_dry_run', 'completed');

-- Add step column with backfill from existing data
ALTER TABLE "onboarding_state" ADD COLUMN "step" "onboarding_step" NOT NULL DEFAULT 'install';

UPDATE "onboarding_state"
SET "step" = CASE
    WHEN "completed_at" IS NOT NULL THEN 'completed'::"onboarding_step"
    WHEN "production_url" IS NOT NULL THEN 'url'::"onboarding_step"
    WHEN "agent_connected_at" IS NOT NULL THEN 'working'::"onboarding_step"
    ELSE 'install'::"onboarding_step"
END;

-- Drop unused columns
ALTER TABLE "onboarding_state" DROP COLUMN "current_step";
ALTER TABLE "onboarding_state" DROP COLUMN "ngrok_url";
ALTER TABLE "onboarding_state" DROP COLUMN "ngrok_tests_passed";
