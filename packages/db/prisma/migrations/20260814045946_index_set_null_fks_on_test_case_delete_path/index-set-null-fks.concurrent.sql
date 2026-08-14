-- Production pre-step for 20260814045946_index_set_null_fks_on_test_case_delete_path.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, and Prisma wraps every
-- migration in one - so run this by hand against production BEFORE deploying the
-- migration. The migration itself is IF NOT EXISTS, so it then does nothing.
--
-- Run statement by statement. A failed CONCURRENTLY build leaves an INVALID index
-- that must be dropped before retrying:
--   DROP INDEX CONCURRENTLY IF EXISTS "<name>";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_case_assignment_plan_id_idx" ON "test_case_assignment"("plan_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_case_assignment_steps_id_idx" ON "test_case_assignment"("steps_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_generation_steps_id_idx" ON "test_generation"("steps_id");
