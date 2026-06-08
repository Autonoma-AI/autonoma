-- CreateEnum
CREATE TYPE "step_attempt_status" AS ENUM ('success', 'failed');

-- CreateTable
CREATE TABLE "step_attempt" (
    "id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "interaction" TEXT NOT NULL,
    "params" JSONB,
    "status" "step_attempt_status" NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "error_name" TEXT,
    "screenshot_before" TEXT,
    "screenshot_after" TEXT,
    "generation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "step_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_attempt_generation_id_idx" ON "step_attempt"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "step_attempt_generation_id_order_key" ON "step_attempt"("generation_id", "order");

-- AddForeignKey
ALTER TABLE "step_attempt" ADD CONSTRAINT "step_attempt_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "test_generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_attempt" ADD CONSTRAINT "step_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one successful StepAttempt per existing StepOutput, joined to its
-- generation (via the generation's StepOutputList) and its source StepInput.
-- Reuses the existing screenshot keys - no re-upload. StepInput is the
-- successful-only replay list, so every backfilled attempt has status 'success'
-- and its order matches the per-generation StepOutput order.
INSERT INTO "step_attempt" (
    "id",
    "order",
    "interaction",
    "params",
    "status",
    "output",
    "screenshot_before",
    "screenshot_after",
    "generation_id",
    "created_at",
    "updated_at",
    "organization_id"
)
SELECT
    gen_random_uuid()::text,
    so."order",
    si."interaction",
    si."params",
    'success',
    so."output",
    si."screenshot_before",
    si."screenshot_after",
    tg."id",
    tg."created_at",
    tg."updated_at",
    tg."organization_id"
FROM "step_output" so
JOIN "step_output_list" sol ON so."list_id" = sol."id"
JOIN "test_generation" tg ON tg."outputs_id" = sol."id"
JOIN "step_input" si ON so."step_input_id" = si."id";
