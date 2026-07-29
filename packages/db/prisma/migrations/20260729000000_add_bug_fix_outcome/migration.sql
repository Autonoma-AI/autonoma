-- CreateEnum
CREATE TYPE "bug_fix_outcome_kind" AS ENUM ('fixed_before_merge', 'merged_with_bug', 'skipped', 'unknown');

-- CreateTable
CREATE TABLE "bug_fix_outcome" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "branch_id" TEXT NOT NULL,
    "issue_id" TEXT,
    "outcome" "bug_fix_outcome_kind" NOT NULL,
    "severity" TEXT,
    "merged_at" TIMESTAMP(3),
    "merged_by_login" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_fix_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bug_fix_outcome_organization_id_created_at_idx" ON "bug_fix_outcome"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "bug_fix_outcome_repo_full_name_pr_number_idx" ON "bug_fix_outcome"("repo_full_name", "pr_number");

-- CreateIndex
CREATE UNIQUE INDEX "bug_fix_outcome_branch_id_issue_id_key" ON "bug_fix_outcome"("branch_id", "issue_id");
