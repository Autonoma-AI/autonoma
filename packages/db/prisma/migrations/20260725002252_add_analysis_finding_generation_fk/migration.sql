-- A finding's generation is the run its verdict judged, and nothing recorded it before this column. Existing rows
-- are backfilled best-effort through the only link that ever existed: the finding's `slug` matched against a test
-- case in the snapshot's application, then that test case's generation on the same snapshot.
--
-- The pick is `updated_at DESC` because a self-healed test has more than one generation on the snapshot and the
-- verdict was reached on the LAST one - the re-run - which is also the most recently updated. That is a heuristic,
-- not a record: a backfilled row on a self-healed test points at the right generation by construction, but nothing
-- in the data proves it. Rows written after this migration carry the id the Investigator actually ran.
ALTER TABLE "analysis_finding" ADD COLUMN "generation_id" TEXT;

UPDATE "analysis_finding" f
   SET "generation_id" = (
       SELECT tg."id"
         FROM "branch_snapshot" bs
         JOIN "branch" b ON b."id" = bs."branch_id"
         JOIN "test_case" tc ON tc."slug" = f."slug" AND tc."application_id" = b."application_id"
         JOIN "test_plan" tp ON tp."test_case_id" = tc."id"
         JOIN "test_generation" tg ON tg."test_plan_id" = tp."id"
        WHERE bs."id" = f."report_snapshot_id"
          AND tg."snapshot_id" = f."report_snapshot_id"
          AND tg."shadow" = false
        ORDER BY tg."updated_at" DESC
        LIMIT 1);

-- A finding whose test case or generation is already gone cannot be linked and cannot satisfy the NOT NULL. Drop
-- those rather than weaken the column: a finding with no run behind it has no evidence to show. This matched
-- nothing when the migration was written (all 38 rows linked); it exists so an environment with pruned generations
-- migrates instead of failing.
DELETE FROM "analysis_finding" WHERE "generation_id" IS NULL;

ALTER TABLE "analysis_finding" ALTER COLUMN "generation_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "analysis_finding" ADD CONSTRAINT "analysis_finding_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "test_generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
