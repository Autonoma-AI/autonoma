-- AlterTable
ALTER TABLE "branch" ADD COLUMN "pr_number" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "branch_application_id_pr_number_key" ON "branch"("application_id", "pr_number");
