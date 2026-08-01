/*
  Warnings:

  - You are about to drop the `previewkit_addon` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `previewkit_org_secret` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "previewkit_addon" DROP CONSTRAINT "previewkit_addon_environment_id_fkey";

-- DropForeignKey
ALTER TABLE "previewkit_org_secret" DROP CONSTRAINT "previewkit_org_secret_encryption_key_id_fkey";

-- DropForeignKey
ALTER TABLE "previewkit_org_secret" DROP CONSTRAINT "previewkit_org_secret_organization_id_fkey";

-- DropTable
DROP TABLE "previewkit_addon";

-- DropTable
DROP TABLE "previewkit_org_secret";

-- DropEnum
DROP TYPE "previewkit_addon_status";
