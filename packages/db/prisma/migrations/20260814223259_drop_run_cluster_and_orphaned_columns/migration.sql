/*
  Warnings:

  - You are about to drop the column `run_id` on the `ai_cost_record` table. All the data in the column will be lost.
  - You are about to drop the column `review_id` on the `issue` table. All the data in the column will be lost.
  - You are about to drop the column `run_review_id` on the `issue` table. All the data in the column will be lost.
  - You are about to drop the column `wait_condition` on the `step_input` table. All the data in the column will be lost.
  - You are about to drop the column `run_id` on the `step_output_list` table. All the data in the column will be lost.
  - You are about to drop the column `quarantine_issue_id` on the `test_case_assignment` table. All the data in the column will be lost.
  - You are about to drop the column `steps_id` on the `test_case_assignment` table. All the data in the column will be lost.
  - You are about to drop the `generation_review` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `run` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `run_review` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ai_cost_record" DROP CONSTRAINT "ai_cost_record_run_id_fkey";

-- DropForeignKey
ALTER TABLE "generation_review" DROP CONSTRAINT "generation_review_generation_id_fkey";

-- DropForeignKey
ALTER TABLE "generation_review" DROP CONSTRAINT "generation_review_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "issue" DROP CONSTRAINT "issue_review_id_fkey";

-- DropForeignKey
ALTER TABLE "issue" DROP CONSTRAINT "issue_run_review_id_fkey";

-- DropForeignKey
ALTER TABLE "run" DROP CONSTRAINT "run_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "run" DROP CONSTRAINT "run_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "run" DROP CONSTRAINT "run_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "run" DROP CONSTRAINT "run_scenario_instance_id_fkey";

-- DropForeignKey
ALTER TABLE "run_review" DROP CONSTRAINT "run_review_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "run_review" DROP CONSTRAINT "run_review_run_id_fkey";

-- DropForeignKey
ALTER TABLE "step_output_list" DROP CONSTRAINT "step_output_list_run_id_fkey";

-- DropForeignKey
ALTER TABLE "test_case_assignment" DROP CONSTRAINT "test_case_assignment_quarantine_issue_id_fkey";

-- DropForeignKey
ALTER TABLE "test_case_assignment" DROP CONSTRAINT "test_case_assignment_steps_id_fkey";

-- DropIndex
DROP INDEX "ai_cost_record_run_id_idx";

-- DropIndex
DROP INDEX "issue_review_id_key";

-- DropIndex
DROP INDEX "issue_run_review_id_key";

-- DropIndex
DROP INDEX "step_output_list_run_id_key";

-- DropIndex
DROP INDEX "test_case_assignment_steps_id_idx";

-- AlterTable
ALTER TABLE "ai_cost_record" DROP COLUMN "run_id";

-- AlterTable
ALTER TABLE "issue" DROP COLUMN "review_id",
DROP COLUMN "run_review_id";

-- AlterTable
ALTER TABLE "step_input" DROP COLUMN "wait_condition";

-- AlterTable
ALTER TABLE "step_output_list" DROP COLUMN "run_id";

-- AlterTable
ALTER TABLE "test_case_assignment" DROP COLUMN "quarantine_issue_id",
DROP COLUMN "steps_id";

-- DropTable
DROP TABLE "generation_review";

-- DropTable
DROP TABLE "run";

-- DropTable
DROP TABLE "run_review";

-- DropEnum
DROP TYPE "generation_review_verdict";

-- DropEnum
DROP TYPE "review_status";

-- DropEnum
DROP TYPE "run_review_verdict";

-- DropEnum
DROP TYPE "run_status";
