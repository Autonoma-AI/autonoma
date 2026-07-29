-- CreateTable
CREATE TABLE "branch_contributor" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "branch_id" TEXT,
    "login" TEXT,
    "display_name" TEXT,
    "email" TEXT,
    "is_opener" BOOLEAN NOT NULL DEFAULT false,
    "contributor_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_contributor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_contributor_organization_id_created_at_idx" ON "branch_contributor"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "branch_contributor_repo_full_name_pr_number_idx" ON "branch_contributor"("repo_full_name", "pr_number");

-- CreateIndex
CREATE INDEX "branch_contributor_login_idx" ON "branch_contributor"("login");

-- CreateIndex
CREATE UNIQUE INDEX "branch_contributor_repo_full_name_pr_number_contributor_key_key" ON "branch_contributor"("repo_full_name", "pr_number", "contributor_key");
