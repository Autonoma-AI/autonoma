-- Wire the Reporter into the analysis pipeline. Findings become run-scoped, keyed to the AnalysisJob on the shared
-- snapshot-id column, and carry their selection provenance + self-heal note. The AnalysisReport is authored by the
-- Reporter (its existence means the Reporter ran), so findings key to the job, NOT the report: add the job FK and
-- drop the finding -> report FK.

-- AlterTable
ALTER TABLE "analysis_finding" ADD COLUMN     "selection_reason" TEXT,
ADD COLUMN     "self_heal_note" TEXT;

-- DropForeignKey
ALTER TABLE "analysis_finding" DROP CONSTRAINT "analysis_finding_report_snapshot_id_fkey";

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_job_fkey" FOREIGN KEY ("report_snapshot_id") REFERENCES "analysis_job"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;
