-- Backfill organization_id for ai_cost_record rows written before the column
-- existed, by joining through whichever of generation/run/investigation_snapshot
-- the row is tied to, down to branch_snapshot -> branch -> application. Every
-- extant row resolves through exactly one of these (onDelete: Cascade on all
-- three FKs means an unresolvable parent chain would have deleted the row too).
UPDATE "ai_cost_record" acr
SET "organization_id" = app.organization_id
FROM "branch_snapshot" bs
JOIN "branch" b ON b.id = bs.branch_id
JOIN "application" app ON app.id = b.application_id
WHERE bs.id = COALESCE(
    (SELECT tg.snapshot_id FROM "test_generation" tg WHERE tg.id = acr.generation_id),
    (SELECT tca.snapshot_id FROM "run" r JOIN "test_case_assignment" tca ON tca.id = r.assignment_id WHERE r.id = acr.run_id),
    acr.investigation_snapshot_id
)
AND acr."organization_id" IS NULL;

-- AlterTable
ALTER TABLE "ai_cost_record" ALTER COLUMN "organization_id" SET NOT NULL;
