-- AlterEnum
ALTER TYPE "credit_transaction_type" ADD VALUE 'PREVIEW_RUNTIME_CONSUMPTION';

-- AlterTable
ALTER TABLE "billing_pricing" ADD COLUMN     "credits_per_gb_memory_hour" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credits_per_vcpu_hour" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "credit_transaction" ADD COLUMN     "usage_window_id" TEXT;

-- AlterTable
ALTER TABLE "previewkit_environment" ADD COLUMN     "metered_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "previewkit_usage_window" (
    "id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "vcpu_seconds" DOUBLE PRECISION NOT NULL,
    "gb_seconds" DOUBLE PRECISION NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previewkit_usage_window_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "previewkit_usage_window_organization_id_idx" ON "previewkit_usage_window"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_usage_window_environment_id_window_start_key" ON "previewkit_usage_window"("environment_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transaction_usage_window_id_key" ON "credit_transaction"("usage_window_id");

-- AddForeignKey
ALTER TABLE "previewkit_usage_window" ADD CONSTRAINT "previewkit_usage_window_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "previewkit_environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

