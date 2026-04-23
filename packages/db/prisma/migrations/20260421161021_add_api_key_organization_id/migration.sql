-- Add organization_id to api_key. Backfill existing rows to an org the user belongs to
-- (first membership — matches the previous buggy behaviour so keys keep working),
-- then enforce NOT NULL, add FK + index.

ALTER TABLE "api_key" ADD COLUMN "organization_id" TEXT;

UPDATE "api_key" ak
SET "organization_id" = (
    SELECT m."organization_id"
    FROM "member" m
    WHERE m."user_id" = ak."user_id"
    ORDER BY m."created_at" ASC
    LIMIT 1
)
WHERE ak."organization_id" IS NULL;

-- If any row still has NULL it means the user has no memberships; drop those keys.
DELETE FROM "api_key" WHERE "organization_id" IS NULL;

ALTER TABLE "api_key" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "api_key_organization_id_idx" ON "api_key"("organization_id");
