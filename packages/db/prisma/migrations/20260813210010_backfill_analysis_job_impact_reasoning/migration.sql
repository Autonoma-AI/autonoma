-- Backfill the impact reasoning onto the job for every run settled before the writer moved it there. Only the
-- writer (the impact stage) runs before this migration, so the sole gap is historical reports whose job column is
-- still NULL; new runs already populate the job directly. Bounded to those rows, and idempotent.
UPDATE "analysis_job" AS j
SET "impact_reasoning" = r."impact_reasoning"
FROM "analysis_report" AS r
WHERE r."snapshot_id" = j."snapshot_id"
  AND j."impact_reasoning" IS NULL
  AND r."impact_reasoning" IS NOT NULL;
