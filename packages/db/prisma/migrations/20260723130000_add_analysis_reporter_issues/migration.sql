-- Additive and dormant: the Reporter agent's branch-scoped AnalysisIssue table, its Finding.issue_id backlink,
-- and the AnalysisReport report-markdown/evidence columns. Nothing in the live pipeline writes any of these yet
-- (the Reconciler still owns the run); the Reporter is exercised by fixtures until the reconciler->reporter swap.
-- No backfill - existing rows keep issue_id/report_markdown/evidence_manifest null.

-- AlterTable
ALTER TABLE "analysis_report" ADD COLUMN "report_markdown" TEXT;
ALTER TABLE "analysis_report" ADD COLUMN "evidence_manifest" JSONB;

-- AlterTable
ALTER TABLE "analysis_finding" ADD COLUMN "issue_id" TEXT;

-- CreateTable
CREATE TABLE "analysis_issue" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expected_behavior" TEXT,
    "actual_behavior" TEXT NOT NULL,
    "narrative_markdown" TEXT NOT NULL,
    "finding_slugs" JSONB NOT NULL,
    "evidence_manifest" JSONB,
    "primary_screenshot" JSONB,
    "suspected_cause" JSONB,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_finding_issue_id_idx" ON "analysis_finding"("issue_id");

-- CreateIndex
CREATE INDEX "analysis_issue_branch_id_status_idx" ON "analysis_issue"("branch_id", "status");

-- CreateIndex
CREATE INDEX "analysis_issue_organization_id_idx" ON "analysis_issue"("organization_id");

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "analysis_issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue" ADD CONSTRAINT "analysis_issue_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue" ADD CONSTRAINT "analysis_issue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
