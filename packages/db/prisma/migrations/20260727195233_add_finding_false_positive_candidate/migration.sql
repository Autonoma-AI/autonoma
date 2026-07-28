-- CreateEnum
CREATE TYPE "false_positive_candidate_source" AS ENUM ('mcp_client_agent', 'skip_reason');

-- CreateTable
CREATE TABLE "finding_false_positive_candidate" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "source" "false_positive_candidate_source" NOT NULL,
    "reported_by" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_false_positive_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finding_false_positive_candidate_organization_id_created_at_idx" ON "finding_false_positive_candidate"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "finding_false_positive_candidate_repo_full_name_pr_number_idx" ON "finding_false_positive_candidate"("repo_full_name", "pr_number");
