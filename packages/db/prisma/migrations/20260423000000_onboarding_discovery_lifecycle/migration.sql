-- Expand the OnboardingStep enum with intermediate discovery nodes and add
-- data-only columns to capture discovery lifecycle observability.
-- The old `scenario_dry_run` value is NOT dropped here — a follow-up migration
-- backfills rows onto the new values then retires it (Postgres requires that
-- ADD VALUE and usage of the new values happen in separate transactions).

ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'webhook_configuring';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'discovering';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'discovered';
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'dry_run_passed';

ALTER TABLE "onboarding_state"
  ADD COLUMN "last_discovery_error" TEXT,
  ADD COLUMN "last_discovered_at" TIMESTAMP(3),
  ADD COLUMN "last_discovered_models" INTEGER,
  ADD COLUMN "discovery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discovering_started_at" TIMESTAMP(3);
