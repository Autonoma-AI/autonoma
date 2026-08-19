/*
  Warnings:

  - You are about to drop the `bug` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `bug_test_case_evidence` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `issue` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "bug" DROP CONSTRAINT "bug_application_id_fkey";

-- DropForeignKey
ALTER TABLE "bug" DROP CONSTRAINT "bug_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "bug" DROP CONSTRAINT "bug_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "bug_test_case_evidence" DROP CONSTRAINT "bug_test_case_evidence_bug_id_fkey";

-- DropForeignKey
ALTER TABLE "bug_test_case_evidence" DROP CONSTRAINT "bug_test_case_evidence_test_case_id_fkey";

-- DropForeignKey
ALTER TABLE "issue" DROP CONSTRAINT "issue_bug_id_fkey";

-- DropForeignKey
ALTER TABLE "issue" DROP CONSTRAINT "issue_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "issue" DROP CONSTRAINT "issue_snapshot_id_fkey";

-- DropTable
DROP TABLE "bug";

-- DropTable
DROP TABLE "bug_test_case_evidence";

-- DropTable
DROP TABLE "issue";

-- DropEnum
DROP TYPE "bug_status";

-- DropEnum
DROP TYPE "issue_kind";

-- DropEnum
DROP TYPE "issue_severity";
