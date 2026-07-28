-- Splits the analysis run's per-test finding from the per-iteration classification that produces its verdict.
-- The Investigator classifies a test more than once (a self-heal rewrites the plan and re-runs it), and the old
-- shape kept only the last verdict; every earlier one was overwritten. Findings now hold the per-test facts and
-- point at their current classification, while every iteration persists its own row.
--
-- The existing rows are preserved, not dropped: each becomes a finding plus its one classification. The column
-- drops therefore come LAST, after every value has been copied out of them.

-- CreateTable
CREATE TABLE "analysis_classification" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "generation_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" TEXT,
    "headline" TEXT NOT NULL,
    "expected_behavior" TEXT,
    "actual_behavior" TEXT,
    "what_happened" TEXT,
    "observed_app_issues" TEXT,
    "remediation" TEXT,
    "root_cause" TEXT,
    "false_positive_risk" TEXT,
    "plan" TEXT,
    "run_success" BOOLEAN,
    "step_count" INTEGER,
    "run_steps" JSONB,
    "run_trace" JSONB,
    "evidence" JSONB,
    "video_key" TEXT,
    "optimized_video_key" TEXT,
    "screenshot_key" TEXT,
    "clip_key" TEXT,
    "conversation_url" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_classification_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "analysis_finding" ADD COLUMN     "current_classification_id" TEXT,
ADD COLUMN     "test_case_id" TEXT;

-- AlterTable
ALTER TABLE "analysis_issue" ADD COLUMN     "primary_test_case_id" TEXT;

-- Backfill: one classification per existing finding, carrying the verdict it recorded. Ids are cuid-shaped so
-- they sit alongside application-generated ones; `number` is 1 for every migrated row - a self-heal's earlier
-- iterations were never persisted, so there is nothing to number them against.
INSERT INTO "analysis_classification" (
    "id", "finding_id", "number", "generation_id", "category", "confidence", "headline",
    "expected_behavior", "actual_behavior", "what_happened", "observed_app_issues", "remediation", "root_cause",
    "false_positive_risk", "plan", "run_success", "step_count", "run_steps", "run_trace", "evidence",
    "video_key", "optimized_video_key", "screenshot_key", "clip_key", "conversation_url", "error",
    "created_at", "organization_id"
)
SELECT
    'c' || substr(md5(random()::text || clock_timestamp()::text || f."id"), 1, 24),
    f."id", 1, f."generation_id", f."category", f."confidence", f."headline",
    f."expected_behavior", f."actual_behavior", f."what_happened", f."observed_app_issues", f."remediation",
    f."root_cause", f."false_positive_risk", f."plan", f."run_success", f."step_count", f."run_steps",
    f."run_trace", f."evidence", f."video_key", f."optimized_video_key", f."screenshot_key", f."clip_key",
    f."classification_conversation_url", f."error", f."created_at", f."organization_id"
FROM "analysis_finding" f;

UPDATE "analysis_finding" f
SET "current_classification_id" = c."id"
FROM "analysis_classification" c
WHERE c."finding_id" = f."id";

-- Backfill the test each finding is about, resolved through the generation it judged.
UPDATE "analysis_finding" f
SET "test_case_id" = p."test_case_id"
FROM "test_generation" g
JOIN "test_plan" p ON p."id" = g."test_plan_id"
WHERE g."id" = f."generation_id";

-- Every finding has a NOT NULL generation FK and every plan a NOT NULL test case, so the backfill above is total.
-- Left to fail loudly here rather than defended with a delete: losing rows silently is the bug being fixed.
ALTER TABLE "analysis_finding" ALTER COLUMN "test_case_id" SET NOT NULL;

-- Backfill the issue's designated reproduction: the slug the Reporter named, resolved against its branch's app.
UPDATE "analysis_issue" i
SET "primary_test_case_id" = tc."id"
FROM "branch" b
JOIN "test_case" tc ON tc."application_id" = b."application_id"
WHERE b."id" = i."branch_id"
  AND i."primary_finding_slug" IS NOT NULL
  AND tc."slug" = i."primary_finding_slug";

-- DropForeignKey
ALTER TABLE "analysis_finding" DROP CONSTRAINT "analysis_finding_generation_id_fkey";

-- DropIndex
DROP INDEX "analysis_finding_organization_id_category_idx";

-- DropIndex
DROP INDEX "analysis_finding_report_snapshot_id_finding_key_key";

-- AlterTable
ALTER TABLE "analysis_finding" DROP COLUMN "actual_behavior",
DROP COLUMN "category",
DROP COLUMN "classification_conversation_url",
DROP COLUMN "clip_key",
DROP COLUMN "confidence",
DROP COLUMN "covered_slugs",
DROP COLUMN "display_order",
DROP COLUMN "error",
DROP COLUMN "evidence",
DROP COLUMN "expected_behavior",
DROP COLUMN "false_positive_risk",
DROP COLUMN "finding_key",
DROP COLUMN "generation_id",
DROP COLUMN "headline",
DROP COLUMN "observed_app_issues",
DROP COLUMN "optimized_video_key",
DROP COLUMN "plan",
DROP COLUMN "plan_edited",
DROP COLUMN "remediation",
DROP COLUMN "root_cause",
DROP COLUMN "run_steps",
DROP COLUMN "run_success",
DROP COLUMN "run_trace",
DROP COLUMN "screenshot_key",
DROP COLUMN "self_heal_note",
DROP COLUMN "slug",
DROP COLUMN "step_count",
DROP COLUMN "video_key",
DROP COLUMN "what_happened";

-- AlterTable
ALTER TABLE "analysis_issue" DROP COLUMN "finding_slugs",
DROP COLUMN "primary_finding_slug";

-- CreateIndex
CREATE INDEX "analysis_classification_finding_id_idx" ON "analysis_classification"("finding_id");

-- CreateIndex
CREATE INDEX "analysis_classification_organization_id_category_idx" ON "analysis_classification"("organization_id", "category");

-- CreateIndex
-- Postgres does not index a FK's referencing side, and the RI trigger seq-scans the child on every parent delete.
-- Pending generations are discarded on every successful analysis run, and deleting a TestCase cascades to findings
-- and nulls an issue's designated reproduction, so all three of these run on hot paths.
CREATE INDEX "analysis_classification_generation_id_idx" ON "analysis_classification"("generation_id");

-- CreateIndex
CREATE INDEX "analysis_finding_test_case_id_idx" ON "analysis_finding"("test_case_id");

-- CreateIndex
CREATE INDEX "analysis_issue_primary_test_case_id_idx" ON "analysis_issue"("primary_test_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_classification_finding_id_number_key" ON "analysis_classification"("finding_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_finding_current_classification_id_key" ON "analysis_finding"("current_classification_id");

-- CreateIndex
CREATE INDEX "analysis_finding_organization_id_idx" ON "analysis_finding"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_finding_report_snapshot_id_test_case_id_key" ON "analysis_finding"("report_snapshot_id", "test_case_id");

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_current_classification_id_fkey" FOREIGN KEY ("current_classification_id") REFERENCES "analysis_classification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_classification" ADD CONSTRAINT "analysis_classification_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "analysis_finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_classification" ADD CONSTRAINT "analysis_classification_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "test_generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_classification" ADD CONSTRAINT "analysis_classification_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_issue" ADD CONSTRAINT "analysis_issue_primary_test_case_id_fkey" FOREIGN KEY ("primary_test_case_id") REFERENCES "test_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
