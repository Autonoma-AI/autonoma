-- CreateEnum
CREATE TYPE "diffs_job_status" AS ENUM ('pending', 'analyzing', 'replaying', 'resolving', 'generating', 'finalizing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "affected_reason" AS ENUM ('code_change', 'merge_plan_imported', 'merge_conflict');

-- CreateEnum
CREATE TYPE "test_candidate_status" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "diffs_job" (
    "snapshot_id" TEXT NOT NULL,
    "status" "diffs_job_status" NOT NULL DEFAULT 'pending',
    "analysis_reasoning" TEXT,
    "resolution_reasoning" TEXT,
    "failure_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "diffs_job_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "affected_test" (
    "snapshot_id" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "affected_reason" "affected_reason" NOT NULL,
    "reasoning" TEXT NOT NULL,
    "run_id" TEXT,
    "generation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "affected_test_pkey" PRIMARY KEY ("snapshot_id","test_case_id")
);

-- CreateTable
CREATE TABLE "test_candidate" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "status" "test_candidate_status" NOT NULL DEFAULT 'pending',
    "accepted_test_case_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "test_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affected_test_run_id_key" ON "affected_test"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "affected_test_generation_id_key" ON "affected_test"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_candidate_accepted_test_case_id_key" ON "test_candidate"("accepted_test_case_id");

-- CreateIndex
CREATE INDEX "test_candidate_snapshot_id_idx" ON "test_candidate"("snapshot_id");

-- AddForeignKey
ALTER TABLE "diffs_job" ADD CONSTRAINT "diffs_job_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diffs_job" ADD CONSTRAINT "diffs_job_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affected_test" ADD CONSTRAINT "affected_test_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "diffs_job"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affected_test" ADD CONSTRAINT "affected_test_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affected_test" ADD CONSTRAINT "affected_test_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affected_test" ADD CONSTRAINT "affected_test_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "test_generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affected_test" ADD CONSTRAINT "affected_test_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_candidate" ADD CONSTRAINT "test_candidate_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "diffs_job"("snapshot_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_candidate" ADD CONSTRAINT "test_candidate_accepted_test_case_id_fkey" FOREIGN KEY ("accepted_test_case_id") REFERENCES "test_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_candidate" ADD CONSTRAINT "test_candidate_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
