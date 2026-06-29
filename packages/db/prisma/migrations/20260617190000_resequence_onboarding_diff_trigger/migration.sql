-- Re-sequence onboarding around "go live first": add the per-PR diff-trigger
-- step just before completion, and track SDK dry-run + diff-trigger confirmation
-- as capabilities outside the linear `step`.
ALTER TYPE "onboarding_step" ADD VALUE IF NOT EXISTS 'diff_trigger' BEFORE 'completed';

-- New rows start at the merged "Add app" (github) step now that SDK + CLI work
-- moved out of the required path.
ALTER TABLE "onboarding_state" ALTER COLUMN "step" SET DEFAULT 'github';

ALTER TABLE "onboarding_state"
  ADD COLUMN "dry_run_passed_at" TIMESTAMP(3),
  ADD COLUMN "diff_trigger_confirmed_at" TIMESTAMP(3);
