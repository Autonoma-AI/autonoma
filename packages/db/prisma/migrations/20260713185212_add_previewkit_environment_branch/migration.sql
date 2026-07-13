-- AlterTable
ALTER TABLE "previewkit_environment" ADD COLUMN     "branch_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_environment_branch_id_key" ON "previewkit_environment"("branch_id");

-- AddForeignKey
ALTER TABLE "previewkit_environment" ADD CONSTRAINT "previewkit_environment_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link existing environments to the branch they deploy. The relation was previously reconstructed at
-- runtime from (github_repository_id, pr_number); this makes it explicit for historical rows. Two legs:
--   * PR environments (pr_number > 0) -> application -> feature_branch_info (pr_number) -> feature branch.
--   * The main-branch environment (pr_number = 0) -> application.main_branch_id.
-- ROW_NUMBER dedupes to a single environment per branch (newest wins) so the unique constraint above always
-- holds, even where a repo rename produced two environment rows for the same PR / main branch.
WITH env_branch AS (
    SELECT e.id AS env_id, fbi.branch_id AS branch_id, e.updated_at, e.id AS tiebreak
    FROM "previewkit_environment" e
    JOIN "application" a
        ON a.organization_id = e.organization_id
       AND a.github_repository_id = e.github_repository_id
    JOIN "feature_branch_info" fbi
        ON fbi.application_id = a.id
       AND fbi.pr_number = e.pr_number
    WHERE e.branch_id IS NULL
      AND e.pr_number > 0

    UNION ALL

    SELECT e.id AS env_id, a.main_branch_id AS branch_id, e.updated_at, e.id AS tiebreak
    FROM "previewkit_environment" e
    JOIN "application" a
        ON a.organization_id = e.organization_id
       AND a.github_repository_id = e.github_repository_id
    WHERE e.branch_id IS NULL
      AND e.pr_number = 0
      AND a.main_branch_id IS NOT NULL
),
ranked AS (
    SELECT
        env_id,
        branch_id,
        ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY updated_at DESC, tiebreak DESC) AS rn
    FROM env_branch
)
UPDATE "previewkit_environment" e
SET "branch_id" = ranked.branch_id
FROM ranked
WHERE ranked.env_id = e.id
  AND ranked.rn = 1;
