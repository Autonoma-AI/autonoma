-- CreateTable
CREATE TABLE "benchmark_run" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "test_plan_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "status" "benchmark_generation_status" NOT NULL DEFAULT 'pending',
    "verdict" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "benchmark_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "benchmark_run_batch_id_idx" ON "benchmark_run"("batch_id");

-- CreateIndex
CREATE INDEX "benchmark_run_run_id_idx" ON "benchmark_run"("run_id");

-- AddForeignKey
ALTER TABLE "benchmark_run" ADD CONSTRAINT "benchmark_run_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "benchmark_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
