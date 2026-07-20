-- CreateEnum
CREATE TYPE "analysis_job_status" AS ENUM ('running', 'completed', 'failed');

-- DropForeignKey
ALTER TABLE "analysis_shadow_run" DROP CONSTRAINT "analysis_shadow_run_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "analysis_shadow_run" DROP CONSTRAINT "analysis_shadow_run_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "branch_snapshot" DROP CONSTRAINT "branch_snapshot_analysis_snapshot_id_fkey";

-- DropIndex
DROP INDEX "branch_snapshot_analysis_snapshot_id_key";

-- AlterTable
ALTER TABLE "branch_snapshot" DROP COLUMN "analysis_snapshot_id";

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "analysis_enabled" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "analysis_shadow_run";

-- CreateTable
CREATE TABLE "analysis_job" (
    "snapshot_id" TEXT NOT NULL,
    "status" "analysis_job_status" NOT NULL DEFAULT 'running',
    "failure_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_job_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "analysis_report" (
    "snapshot_id" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "test_count" INTEGER NOT NULL DEFAULT 0,
    "client_bug_count" INTEGER NOT NULL DEFAULT 0,
    "impact_reasoning" TEXT,
    "coverage" JSONB,
    "narration" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_report_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "analysis_finding" (
    "id" TEXT NOT NULL,
    "report_snapshot_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" TEXT,
    "headline" TEXT NOT NULL,
    "what_happened" TEXT,
    "observed_app_issues" TEXT,
    "remediation" TEXT,
    "root_cause" TEXT,
    "false_positive_risk" TEXT,
    "plan" TEXT,
    "run_success" BOOLEAN,
    "step_count" INTEGER,
    "plan_edited" BOOLEAN,
    "origin" TEXT,
    "run_steps" JSONB,
    "run_trace" JSONB,
    "evidence" JSONB,
    "video_key" TEXT,
    "screenshot_key" TEXT,
    "clip_key" TEXT,
    "error" TEXT,
    "covered_slugs" JSONB,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "analysis_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_finding_report_snapshot_id_idx" ON "analysis_finding"("report_snapshot_id");

-- CreateIndex
CREATE INDEX "analysis_finding_organization_id_category_idx" ON "analysis_finding"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_finding_report_snapshot_id_finding_key_key" ON "analysis_finding"("report_snapshot_id", "finding_key");

-- AddForeignKey
ALTER TABLE "analysis_job" ADD CONSTRAINT "analysis_job_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_job" ADD CONSTRAINT "analysis_job_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_report" ADD CONSTRAINT "analysis_report_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_report" ADD CONSTRAINT "analysis_report_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_report_snapshot_id_fkey" FOREIGN KEY ("report_snapshot_id") REFERENCES "analysis_report"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

