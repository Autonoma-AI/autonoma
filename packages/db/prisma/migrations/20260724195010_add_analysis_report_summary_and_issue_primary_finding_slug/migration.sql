-- The Reporter now authors two things it previously left to readers to guess at:
--   * analysis_report.summary - a short prose summary of the run, for surfaces that need a PARAGRAPH rather than
--     the full report document (the PR page's verdict subtitle, the GitHub PR comment's body).
--   * analysis_issue.primary_finding_slug - which covered test most clearly REPRODUCES the issue. Readers resolve
--     the newest covering finding for that slug, so an issue's media tracks the PR's current head automatically.

-- AlterTable
ALTER TABLE "analysis_issue" ADD COLUMN     "primary_finding_slug" TEXT;

-- AlterTable: both prose columns are added/constrained the same way - added nullable, backfilled, then set NOT
-- NULL. Every row the Reporter writes carries both, so the constraint states a real invariant; the rows that
-- predate the Reporter have to be given a value first. `narration` is the honest source for both: the retired
-- Reconciler wrote it as exactly a short prose account of the run. The COALESCE is belt-and-braces for an
-- environment where a row somehow has neither, and readers treat an empty value as absent.
ALTER TABLE "analysis_report" ADD COLUMN     "summary" TEXT;
UPDATE "analysis_report" SET "summary" = COALESCE("narration", '') WHERE "summary" IS NULL;
ALTER TABLE "analysis_report" ALTER COLUMN "summary" SET NOT NULL;

UPDATE "analysis_report" SET "report_markdown" = COALESCE("narration", '') WHERE "report_markdown" IS NULL;
ALTER TABLE "analysis_report" ALTER COLUMN "report_markdown" SET NOT NULL;
