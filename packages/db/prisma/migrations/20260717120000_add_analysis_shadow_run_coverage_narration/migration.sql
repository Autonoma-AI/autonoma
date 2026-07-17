-- Two-plane verdict: the coverage-confidence plane summary (per-category counts of non-app-health findings plus
-- the delete-origin split) and the constrained prose narration of the run's finalized verdict. Both live on the
-- droppable shadow island; nothing user-facing FKs into this row. The shadow-vs-diffs comparison enrichment
-- reuses the existing `deployed` JSONB column (no column change), so it needs no DDL here.

-- AlterTable
ALTER TABLE "analysis_shadow_run" ADD COLUMN "coverage" JSONB;
ALTER TABLE "analysis_shadow_run" ADD COLUMN "narration" TEXT;
