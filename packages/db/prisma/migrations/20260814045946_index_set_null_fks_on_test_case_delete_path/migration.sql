-- Index the three FKs that 20260807120000_index_cascade_foreign_keys left behind.
-- That migration scoped itself to ON DELETE CASCADE; these are ON DELETE SET NULL,
-- so it indexed test_case_assignment.test_case_id and skipped plan_id and steps_id
-- right beside it.
--
-- Postgres does not index a referencing column automatically, so nulling a FK
-- sequentially scans the whole child table once per deleted parent row. Deleting a
-- test case cascades to its test plans, then to their step_input_lists, and each of
-- those scanned all 283 MB of test_case_assignment and 99 MB of test_generation.
--
-- Measured against a restore of production, deleting 14 test cases (1,306 plans,
-- 1,055 step lists), by EXPLAIN (ANALYZE) trigger attribution:
--
--   test_case_assignment.steps_id   97.5s   <- 82% of the total
--   test_generation.steps_id        20.3s
--   test_case_assignment.plan_id    ~78s
--   everything else                 <0.5s combined
--
--   before  3m23s
--   after   1.02s
--
-- The same scans are paid by any delete that reaches a test plan, which includes
-- deleting an application or an organization.
--
-- IF NOT EXISTS so this is a no-op against a database where an operator already
-- built these CONCURRENTLY (see index-set-null-fks.concurrent.sql next to this
-- migration). Plain CREATE INDEX takes a SHARE lock and blocks writes to the table
-- for the length of the build - fine on a small database, not on a 1.9M-row one.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_case_assignment_plan_id_idx" ON "test_case_assignment"("plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_case_assignment_steps_id_idx" ON "test_case_assignment"("steps_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "test_generation_steps_id_idx" ON "test_generation"("steps_id");
