-- AlterTable
ALTER TABLE "benchmark_generation" ADD COLUMN     "failure_kind" TEXT;

-- AlterTable
ALTER TABLE "benchmark_run" ADD COLUMN     "failure_kind" TEXT,
ADD COLUMN     "step_count" INTEGER,
ADD COLUMN     "test_generation_id" TEXT;

-- CreateIndex
CREATE INDEX "benchmark_run_test_generation_id_idx" ON "benchmark_run"("test_generation_id");
