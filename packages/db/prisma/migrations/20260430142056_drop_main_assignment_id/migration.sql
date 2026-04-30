/*
  Warnings:

  - You are about to drop the column `main_assignment_id` on the `skill_assignment` table. All the data in the column will be lost.
  - You are about to drop the column `main_assignment_id` on the `test_case_assignment` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "skill_assignment" DROP CONSTRAINT "skill_assignment_main_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "test_case_assignment" DROP CONSTRAINT "test_case_assignment_main_assignment_id_fkey";

-- AlterTable
ALTER TABLE "skill_assignment" DROP COLUMN "main_assignment_id";

-- AlterTable
ALTER TABLE "test_case_assignment" DROP COLUMN "main_assignment_id";
