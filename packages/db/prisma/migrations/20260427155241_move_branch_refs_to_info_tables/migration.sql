-- DropIndex
DROP INDEX "branch_application_id_pr_number_key";

-- CreateTable
CREATE TABLE "feature_branch_info" (
    "branch_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,

    CONSTRAINT "feature_branch_info_pkey" PRIMARY KEY ("branch_id")
);

-- CreateTable
CREATE TABLE "main_branch_info" (
    "branch_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "github_ref" TEXT NOT NULL,

    CONSTRAINT "main_branch_info_pkey" PRIMARY KEY ("branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_branch_info_application_id_pr_number_key" ON "feature_branch_info"("application_id", "pr_number");

-- CreateIndex
CREATE UNIQUE INDEX "main_branch_info_application_id_key" ON "main_branch_info"("application_id");

-- AddForeignKey
ALTER TABLE "feature_branch_info" ADD CONSTRAINT "feature_branch_info_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_branch_info" ADD CONSTRAINT "feature_branch_info_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "main_branch_info" ADD CONSTRAINT "main_branch_info_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "main_branch_info" ADD CONSTRAINT "main_branch_info_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill feature_branch_info from existing PR-tied branches
INSERT INTO "feature_branch_info" ("branch_id", "application_id", "pr_number")
SELECT "id", "application_id", "pr_number"
FROM "branch"
WHERE "pr_number" IS NOT NULL;

-- Backfill main_branch_info from each application's main branch
INSERT INTO "main_branch_info" ("branch_id", "application_id", "github_ref")
SELECT b."id", a."id", COALESCE(b."github_ref", 'main')
FROM "branch" b
JOIN "application" a ON a."main_branch_id" = b."id";
