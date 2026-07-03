-- AlterTable
ALTER TABLE "ai_cost_record" ADD COLUMN     "investigation_snapshot_id" TEXT;

-- CreateIndex
CREATE INDEX "ai_cost_record_investigation_snapshot_id_idx" ON "ai_cost_record"("investigation_snapshot_id");

-- AddForeignKey
ALTER TABLE "ai_cost_record" ADD CONSTRAINT "ai_cost_record_investigation_snapshot_id_fkey" FOREIGN KEY ("investigation_snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
