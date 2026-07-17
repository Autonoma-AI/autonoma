-- AlterTable
ALTER TABLE "branch_snapshot" ADD COLUMN     "analysis_snapshot_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "branch_snapshot_analysis_snapshot_id_key" ON "branch_snapshot"("analysis_snapshot_id");

-- AddForeignKey
ALTER TABLE "branch_snapshot" ADD CONSTRAINT "branch_snapshot_analysis_snapshot_id_fkey" FOREIGN KEY ("analysis_snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

