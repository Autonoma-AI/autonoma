-- AlterTable
ALTER TABLE "feature_branch_info" ADD COLUMN     "merge_commit_sha" TEXT,
ADD COLUMN     "merged_at" TIMESTAMP(3),
ADD COLUMN     "merged_by_login" TEXT;

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "merge_gate_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "github_check_run" (
    "id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "check_run_id" TEXT NOT NULL,
    "conclusion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_check_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skip_record" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "snapshot_id" TEXT,
    "actor_login" TEXT NOT NULL,
    "open_bug_count" INTEGER NOT NULL,
    "open_finding_ids" JSONB NOT NULL,
    "reason" TEXT,
    "reason_category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skip_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_check_run_repo_full_name_pr_number_idx" ON "github_check_run"("repo_full_name", "pr_number");

-- CreateIndex
CREATE UNIQUE INDEX "github_check_run_repo_full_name_head_sha_key" ON "github_check_run"("repo_full_name", "head_sha");

-- CreateIndex
CREATE INDEX "skip_record_organization_id_created_at_idx" ON "skip_record"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "skip_record_repo_full_name_pr_number_idx" ON "skip_record"("repo_full_name", "pr_number");

-- CreateIndex
CREATE INDEX "skip_record_repo_full_name_head_sha_idx" ON "skip_record"("repo_full_name", "head_sha");
