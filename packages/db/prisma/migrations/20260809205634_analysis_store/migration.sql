-- DropIndex
DROP INDEX "analysis_issue_branch_id_status_idx";

-- AlterTable
ALTER TABLE "analysis_finding" ADD COLUMN     "failure" JSONB;

-- AlterTable
ALTER TABLE "analysis_issue" ADD COLUMN     "resolution_note" TEXT,
ADD COLUMN     "resolved_by_finding_id" TEXT;

-- AlterTable
ALTER TABLE "analysis_job" ADD COLUMN     "superseded" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "analysis_issue_branch_id_resolved_at_idx" ON "analysis_issue"("branch_id", "resolved_at");

-- CreateIndex
CREATE INDEX "analysis_issue_resolved_by_finding_id_idx" ON "analysis_issue"("resolved_by_finding_id");

-- AddForeignKey
ALTER TABLE "analysis_issue" ADD CONSTRAINT "analysis_issue_resolved_by_finding_id_fkey" FOREIGN KEY ("resolved_by_finding_id") REFERENCES "analysis_finding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill `superseded` from the prose the reason column carried before the flag existed. Without this every
-- superseded run already on disk reads as a genuine pipeline failure, and the application health metric that
-- subtracts them regresses for the whole length of its lookback window.
UPDATE "analysis_job"
SET "superseded" = true
WHERE "status" = 'failed' AND "failure_reason" LIKE 'Superseded%';
