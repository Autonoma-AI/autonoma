-- AlterTable
ALTER TABLE "ai_cost_record" ADD COLUMN     "organization_id" TEXT;

-- CreateTable
CREATE TABLE "previewkit_app_build_usage" (
    "id" TEXT NOT NULL,
    "app_build_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "vcpu_seconds" DOUBLE PRECISION NOT NULL,
    "gb_seconds" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previewkit_app_build_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_app_build_usage_app_build_id_key" ON "previewkit_app_build_usage"("app_build_id");

-- CreateIndex
CREATE INDEX "previewkit_app_build_usage_organization_id_idx" ON "previewkit_app_build_usage"("organization_id");

-- CreateIndex
CREATE INDEX "ai_cost_record_organization_id_idx" ON "ai_cost_record"("organization_id");

-- AddForeignKey
ALTER TABLE "previewkit_app_build_usage" ADD CONSTRAINT "previewkit_app_build_usage_app_build_id_fkey" FOREIGN KEY ("app_build_id") REFERENCES "previewkit_app_build"("id") ON DELETE CASCADE ON UPDATE CASCADE;
