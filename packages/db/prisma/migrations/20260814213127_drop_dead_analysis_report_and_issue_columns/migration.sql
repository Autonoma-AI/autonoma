/*
  Warnings:

  - You are about to drop the column `status` on the `analysis_issue` table. All the data in the column will be lost.
  - You are about to drop the column `client_bug_count` on the `analysis_report` table. All the data in the column will be lost.
  - You are about to drop the column `coverage` on the `analysis_report` table. All the data in the column will be lost.
  - You are about to drop the column `narration` on the `analysis_report` table. All the data in the column will be lost.
  - You are about to drop the column `test_count` on the `analysis_report` table. All the data in the column will be lost.
  - You are about to drop the column `verdict` on the `analysis_report` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "analysis_issue" DROP COLUMN "status";

-- AlterTable
ALTER TABLE "analysis_report" DROP COLUMN "client_bug_count",
DROP COLUMN "coverage",
DROP COLUMN "narration",
DROP COLUMN "test_count",
DROP COLUMN "verdict";
