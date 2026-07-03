-- The investigation agent's queryable, native report model - an ISOLATED, DROPPABLE island. It replaces the
-- old S3 report entirely: the API now reads these tables and signs the stored media keys on read. Everything
-- here FKs only OUTWARD (investigation_report -> branch_snapshot / organization, already existing; the child
-- tables -> investigation_report), and nothing in the core app FKs into it, so retiring the agent later is a
-- clean DROP of these tables + columns.

-- CreateEnum
CREATE TYPE "investigation_report_status" AS ENUM ('running', 'completed', 'failed');

-- AlterTable: extend the existing report row with lifecycle, denormalized header, and the deployed-agent blob.
-- s3_key becomes nullable: new reports persist only to these tables (no S3); it survives as a breadcrumb to the
-- legacy markdown the backfill script reads when migrating pre-island reports in.
ALTER TABLE "investigation_report"
    ADD COLUMN "status" "investigation_report_status" NOT NULL DEFAULT 'completed',
    ADD COLUMN "stage" TEXT,
    ADD COLUMN "stage_updated_at" TIMESTAMP(3),
    ADD COLUMN "client" TEXT,
    ADD COLUMN "app_slug" TEXT,
    ADD COLUMN "pr_number" INTEGER,
    ADD COLUMN "pr_title" TEXT,
    ADD COLUMN "pr_body" TEXT,
    ADD COLUMN "repo_full_name" TEXT,
    ADD COLUMN "commit_sha" TEXT,
    ADD COLUMN "deployed" JSONB,
    ALTER COLUMN "s3_key" DROP NOT NULL;

-- CreateTable
CREATE TABLE "investigation_finding" (
    "id" TEXT NOT NULL,
    "report_snapshot_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" TEXT,
    "plan_fidelity" TEXT,
    "false_positive_risk" TEXT,
    "headline" TEXT NOT NULL,
    "what_happened" TEXT,
    "observed_app_issues" TEXT,
    "remediation" TEXT,
    "root_cause" TEXT,
    "suggested_fix_diff" TEXT,
    "plan" TEXT,
    "run_success" BOOLEAN,
    "step_count" INTEGER,
    "run_steps" JSONB,
    "evidence" JSONB,
    "video_key" TEXT,
    "screenshot_key" TEXT,
    "error" TEXT,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "investigation_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_suggested_test" (
    "id" TEXT NOT NULL,
    "report_snapshot_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "validation_passed" BOOLEAN,
    "validation_iterations" INTEGER,
    "validation_failure_reason" TEXT,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "investigation_suggested_test_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "investigation_finding_report_snapshot_id_finding_key_key" ON "investigation_finding"("report_snapshot_id", "finding_key");

-- CreateIndex
CREATE INDEX "investigation_finding_report_snapshot_id_idx" ON "investigation_finding"("report_snapshot_id");

-- CreateIndex
CREATE INDEX "investigation_finding_organization_id_category_idx" ON "investigation_finding"("organization_id", "category");

-- CreateIndex
CREATE INDEX "investigation_suggested_test_report_snapshot_id_idx" ON "investigation_suggested_test"("report_snapshot_id");

-- AddForeignKey
ALTER TABLE "investigation_finding" ADD CONSTRAINT "investigation_finding_report_snapshot_id_fkey" FOREIGN KEY ("report_snapshot_id") REFERENCES "investigation_report"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_suggested_test" ADD CONSTRAINT "investigation_suggested_test_report_snapshot_id_fkey" FOREIGN KEY ("report_snapshot_id") REFERENCES "investigation_report"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;
