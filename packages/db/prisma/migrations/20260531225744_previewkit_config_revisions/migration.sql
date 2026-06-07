-- CreateEnum
CREATE TYPE "previewkit_config_source" AS ENUM ('dashboard', 'api', 'imported_yaml');

-- AlterTable
ALTER TABLE "application" ADD COLUMN     "active_config_revision_id" TEXT;

-- AlterTable
ALTER TABLE "previewkit_environment" ADD COLUMN     "config_revision_id" TEXT,
ADD COLUMN     "resolved_config" JSONB;

-- CreateTable
CREATE TABLE "previewkit_config_revision" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "source" "previewkit_config_source" NOT NULL DEFAULT 'api',
    "document" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previewkit_config_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "previewkit_config_revision_application_id_idx" ON "previewkit_config_revision"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_revision_application_id_revision_key" ON "previewkit_config_revision"("application_id", "revision");

-- AddForeignKey
ALTER TABLE "previewkit_config_revision" ADD CONSTRAINT "previewkit_config_revision_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
