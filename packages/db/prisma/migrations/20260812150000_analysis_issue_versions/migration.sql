-- Split AnalysisIssue's authored CONTENT out of the row that carries its identity + lifecycle, into an append-only
-- AnalysisIssueVersion (mirrors AnalysisFinding -> AnalysisClassification). Every carry-forward now mints a new
-- version and re-points `current_version_id` instead of overwriting title/severity/narrative/cause in place, so a
-- weak Reporter run can no longer destroy a good narrative authored on an earlier snapshot.
--
-- The content columns are RETIRED, not dropped: the prior image's Reporter still writes them on
-- `analysis_issue.create`/`update`, so dropping them here would break every open/carry-forward/resolve during a
-- rollback window. They are kept one deploy - unread by the current code - and only relaxed to nullable so the
-- current create, which omits them, succeeds. Their DROP (and `primary_test_case_id`) rides a follow-up migration
-- one deploy later (#2580), matching the `status` column's treatment.

-- CreateTable
CREATE TABLE "analysis_issue_version" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "snapshot_id" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "expected_behavior" TEXT,
    "actual_behavior" TEXT NOT NULL,
    "narrative_markdown" TEXT NOT NULL,
    "evidence_manifest" JSONB,
    "primary_screenshot" JSONB,
    "primary_test_case_id" TEXT,
    "suspected_cause" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_issue_version_pkey" PRIMARY KEY ("id")
);

-- Backfill: one seed version per existing issue, copying its content verbatim. gen_random_uuid() is core Postgres
-- (13+); the resulting id is a plain String PK, same as every other row here.
INSERT INTO "analysis_issue_version" (
    "id", "issue_id", "snapshot_id", "title", "kind", "severity",
    "expected_behavior", "actual_behavior", "narrative_markdown",
    "evidence_manifest", "primary_screenshot", "primary_test_case_id",
    "suspected_cause", "created_at", "organization_id"
)
SELECT
    gen_random_uuid()::text, ai."id", NULL, ai."title", ai."kind", ai."severity",
    ai."expected_behavior", ai."actual_behavior", ai."narrative_markdown",
    ai."evidence_manifest", ai."primary_screenshot", ai."primary_test_case_id",
    ai."suspected_cause", ai."created_at", ai."organization_id"
FROM "analysis_issue" ai;

-- AlterTable: add the current-version pointer, then aim each issue at its seed version.
ALTER TABLE "analysis_issue" ADD COLUMN "current_version_id" TEXT;

UPDATE "analysis_issue" ai
SET "current_version_id" = v."id"
FROM "analysis_issue_version" v
WHERE v."issue_id" = ai."id" AND v."snapshot_id" IS NULL;

-- Retire the content columns: relaxed to nullable so the current create (which omits them) succeeds, but kept in
-- place, written by no current code, so a rollback to the prior image still finds them. DROP is a follow-up.
ALTER TABLE "analysis_issue" ALTER COLUMN "title" DROP NOT NULL,
ALTER COLUMN "kind" DROP NOT NULL,
ALTER COLUMN "severity" DROP NOT NULL,
ALTER COLUMN "actual_behavior" DROP NOT NULL,
ALTER COLUMN "narrative_markdown" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "analysis_issue_version_issue_id_idx" ON "analysis_issue_version"("issue_id");

-- CreateIndex
CREATE INDEX "analysis_issue_version_organization_id_idx" ON "analysis_issue_version"("organization_id");

-- CreateIndex
CREATE INDEX "analysis_issue_version_primary_test_case_id_idx" ON "analysis_issue_version"("primary_test_case_id");

-- CreateIndex
CREATE INDEX "analysis_issue_version_snapshot_id_idx" ON "analysis_issue_version"("snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_issue_version_issue_id_snapshot_id_key" ON "analysis_issue_version"("issue_id", "snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_issue_current_version_id_key" ON "analysis_issue"("current_version_id");

-- AddForeignKey
ALTER TABLE "analysis_issue" ADD CONSTRAINT "analysis_issue_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "analysis_issue_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue_version" ADD CONSTRAINT "analysis_issue_version_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "analysis_issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue_version" ADD CONSTRAINT "analysis_issue_version_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue_version" ADD CONSTRAINT "analysis_issue_version_primary_test_case_id_fkey" FOREIGN KEY ("primary_test_case_id") REFERENCES "test_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue_version" ADD CONSTRAINT "analysis_issue_version_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
