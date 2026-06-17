-- CreateEnum
CREATE TYPE "benchmark_batch_status" AS ENUM ('running', 'completed');

-- CreateEnum
CREATE TYPE "benchmark_generation_status" AS ENUM ('pending', 'running', 'success', 'failed');

-- CreateTable
CREATE TABLE "benchmark_batch" (
    "id" TEXT NOT NULL,
    "status" "benchmark_batch_status" NOT NULL DEFAULT 'running',
    "repeat_count" INTEGER NOT NULL,
    "app_urls" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "benchmark_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_generation" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "test_plan_id" TEXT NOT NULL,
    "test_generation_id" TEXT NOT NULL,
    "app_url" TEXT NOT NULL,
    "status" "benchmark_generation_status" NOT NULL DEFAULT 'pending',
    "verdict" TEXT,
    "step_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "benchmark_generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "benchmark_generation_batch_id_idx" ON "benchmark_generation"("batch_id");

-- CreateIndex
CREATE INDEX "benchmark_generation_test_generation_id_idx" ON "benchmark_generation"("test_generation_id");

-- AddForeignKey
ALTER TABLE "benchmark_generation" ADD CONSTRAINT "benchmark_generation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "benchmark_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
