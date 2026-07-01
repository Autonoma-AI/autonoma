-- Shadow marker for investigation-created generations. Shadow rows are excluded from user-facing generation
-- views and from the refinement loop's per-test-case dedup, so orphaned `pending` shadow rows never pollute
-- the customer's UI or trip the "one plan per test case" invariant.
ALTER TABLE "test_generation" ADD COLUMN "shadow" BOOLEAN NOT NULL DEFAULT false;
