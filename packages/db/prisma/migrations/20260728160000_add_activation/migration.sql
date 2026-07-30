-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN "activation_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "github_check_run" ADD COLUMN "activation_source" TEXT;
ALTER TABLE "github_check_run" ADD COLUMN "activated_by_login" TEXT;
ALTER TABLE "github_check_run" ADD COLUMN "activated_at" TIMESTAMP(3);
