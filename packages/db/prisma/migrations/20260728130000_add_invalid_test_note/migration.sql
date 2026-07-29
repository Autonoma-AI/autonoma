-- The `invalid_test` justification the classifier writes: which impossibility failure mode (nonexistent feature /
-- unexecutable steps / wrong premise / unrecoverable) and the proof the test cannot be recovered. A dedicated column
-- (not the shared `what_happened` or `plan_mismatch_note`) so the classifier schema can prescribe its specific
-- content. Nullable; set only for an `invalid_test` verdict.

-- AlterTable
ALTER TABLE "analysis_classification" ADD COLUMN "invalid_test_note" TEXT;
