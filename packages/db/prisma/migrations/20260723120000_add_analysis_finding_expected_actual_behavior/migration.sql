-- AlterTable
-- Additive: the classifier's per-category behavior fields (expected vs actual) that replace the free-form
-- what_happened for analysis findings. No backfill - findings written before the split keep what_happened only.
ALTER TABLE "analysis_finding" ADD COLUMN "expected_behavior" TEXT;
ALTER TABLE "analysis_finding" ADD COLUMN "actual_behavior" TEXT;
