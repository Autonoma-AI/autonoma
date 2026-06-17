ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'preview_environment';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'previewkit_configuring';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'previewkit_deploying';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'existing_deploys_configuring';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'existing_deploys_waiting';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'preview_verified';

CREATE TYPE "onboarding_preview_environment_mode" AS ENUM ('previewkit', 'existing_deploys');
CREATE TYPE "onboarding_preview_verification_status" AS ENUM ('idle', 'building', 'ready', 'failed');

ALTER TABLE "onboarding_state"
  ADD COLUMN "preview_environment_mode" "onboarding_preview_environment_mode",
  ADD COLUMN "preview_url" TEXT,
  ADD COLUMN "preview_verification_status" "onboarding_preview_verification_status" NOT NULL DEFAULT 'idle';
