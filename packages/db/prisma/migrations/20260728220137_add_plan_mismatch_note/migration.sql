-- The `plan_mismatch` self-heal post-mortem the classifier writes: what the test asserted that was wrong, the
-- rewrite attempted, and why it still failed. A dedicated column (not the shared `what_happened`) so the classifier
-- schema can prescribe its specific tripartite content. Nullable; set only for a `plan_mismatch` verdict.

-- AlterTable
ALTER TABLE "analysis_classification" ADD COLUMN "plan_mismatch_note" TEXT;
