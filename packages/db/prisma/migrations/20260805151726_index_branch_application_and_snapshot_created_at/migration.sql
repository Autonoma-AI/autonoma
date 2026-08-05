-- DropIndex
DROP INDEX "branch_snapshot_branch_id_idx";

-- CreateIndex
CREATE INDEX "branch_application_id_idx" ON "branch"("application_id");

-- CreateIndex
CREATE INDEX "branch_snapshot_branch_id_created_at_idx" ON "branch_snapshot"("branch_id", "created_at");
