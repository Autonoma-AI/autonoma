/*
  Warnings:

  - A unique constraint covering the columns `[snapshot_id]` on the table `refinement_loop` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "refinement_loop_snapshot_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "refinement_loop_snapshot_id_key" ON "refinement_loop"("snapshot_id");
