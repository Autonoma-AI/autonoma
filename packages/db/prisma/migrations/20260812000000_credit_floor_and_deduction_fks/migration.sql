-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "credit_floor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "credit_transaction" ADD COLUMN     "ai_cost_record_id" TEXT,
ADD COLUMN     "previewkit_app_build_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_transaction_ai_cost_record_id_key" ON "credit_transaction"("ai_cost_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transaction_previewkit_app_build_id_key" ON "credit_transaction"("previewkit_app_build_id");
