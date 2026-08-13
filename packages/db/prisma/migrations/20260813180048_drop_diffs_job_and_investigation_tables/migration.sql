/*
  Warnings:

  - You are about to drop the `affected_test` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `diffs_job` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `investigation_finding` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `investigation_report` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `investigation_suggested_test` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refinement_action` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refinement_iteration` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refinement_iteration_input` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refinement_loop` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "affected_test" DROP CONSTRAINT "affected_test_generation_id_fkey";

-- DropForeignKey
ALTER TABLE "affected_test" DROP CONSTRAINT "affected_test_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "affected_test" DROP CONSTRAINT "affected_test_run_id_fkey";

-- DropForeignKey
ALTER TABLE "affected_test" DROP CONSTRAINT "affected_test_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "affected_test" DROP CONSTRAINT "affected_test_test_case_id_fkey";

-- DropForeignKey
ALTER TABLE "diffs_job" DROP CONSTRAINT "diffs_job_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "diffs_job" DROP CONSTRAINT "diffs_job_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "investigation_finding" DROP CONSTRAINT "investigation_finding_report_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "investigation_report" DROP CONSTRAINT "investigation_report_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "investigation_report" DROP CONSTRAINT "investigation_report_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "investigation_suggested_test" DROP CONSTRAINT "investigation_suggested_test_report_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_action" DROP CONSTRAINT "refinement_action_iteration_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_iteration" DROP CONSTRAINT "refinement_iteration_loop_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_iteration_input" DROP CONSTRAINT "refinement_iteration_input_iteration_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_iteration_input" DROP CONSTRAINT "refinement_iteration_input_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_loop" DROP CONSTRAINT "refinement_loop_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "refinement_loop" DROP CONSTRAINT "refinement_loop_snapshot_id_fkey";

-- DropTable
DROP TABLE "affected_test";

-- DropTable
DROP TABLE "diffs_job";

-- DropTable
DROP TABLE "investigation_finding";

-- DropTable
DROP TABLE "investigation_report";

-- DropTable
DROP TABLE "investigation_suggested_test";

-- DropTable
DROP TABLE "refinement_action";

-- DropTable
DROP TABLE "refinement_iteration";

-- DropTable
DROP TABLE "refinement_iteration_input";

-- DropTable
DROP TABLE "refinement_loop";

-- DropEnum
DROP TYPE "affected_reason";

-- DropEnum
DROP TYPE "diffs_job_status";

-- DropEnum
DROP TYPE "investigation_report_status";

-- DropEnum
DROP TYPE "refinement_action_kind";

-- DropEnum
DROP TYPE "refinement_iteration_status";

-- DropEnum
DROP TYPE "refinement_status";

-- DropEnum
DROP TYPE "refinement_trigger";
