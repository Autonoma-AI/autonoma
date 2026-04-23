-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "base_snapshot_id" TEXT;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_base_snapshot_id_fkey" FOREIGN KEY ("base_snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
