-- Folds each value table into its parent's name, so one row is one secret.
--
-- The bundle rows existed to hold an AWS ARN. With that gone all they carried was
-- (application_id, app_name) / (organization_id, name), which the value rows can
-- carry themselves. Afterwards a "bundle" is simply the set of rows sharing that
-- identity, and an app with no secrets has no rows rather than an empty parent.
--
-- Bundle rows with no values are dropped by this, which is the intended outcome:
-- they are apps whose every secret was deleted, and nothing should still list them.
--
-- The rename is done with its constraints and indexes renamed too. Postgres keeps
-- the old names through `ALTER TABLE ... RENAME TO`, which would leave the new
-- table carrying `previewkit_secret_value_*` names and read as drift forever.

-- === app scope ===

ALTER TABLE "previewkit_secret_value" ADD COLUMN "application_id" TEXT;
ALTER TABLE "previewkit_secret_value" ADD COLUMN "app_name" TEXT;

UPDATE "previewkit_secret_value" AS v
SET "application_id" = s."application_id", "app_name" = s."app_name"
FROM "previewkit_secret" AS s
WHERE v."secret_id" = s."id";

-- The FK to the parent made an unmatched row impossible, so this only asserts it.
ALTER TABLE "previewkit_secret_value" ALTER COLUMN "application_id" SET NOT NULL;
ALTER TABLE "previewkit_secret_value" ALTER COLUMN "app_name" SET NOT NULL;

ALTER TABLE "previewkit_secret_value" DROP CONSTRAINT "previewkit_secret_value_secret_id_fkey";
DROP INDEX "previewkit_secret_value_secret_id_key_key";
ALTER TABLE "previewkit_secret_value" DROP COLUMN "secret_id";

DROP TABLE "previewkit_secret";
ALTER TABLE "previewkit_secret_value" RENAME TO "previewkit_secret";

ALTER TABLE "previewkit_secret" RENAME CONSTRAINT "previewkit_secret_value_pkey" TO "previewkit_secret_pkey";
ALTER TABLE "previewkit_secret" RENAME CONSTRAINT "previewkit_secret_value_encryption_key_id_fkey" TO "previewkit_secret_encryption_key_id_fkey";
ALTER INDEX "previewkit_secret_value_encryption_key_id_idx" RENAME TO "previewkit_secret_encryption_key_id_idx";

ALTER TABLE "previewkit_secret"
    ADD CONSTRAINT "previewkit_secret_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "previewkit_secret_application_id_app_name_key_key"
    ON "previewkit_secret"("application_id", "app_name", "key");
CREATE INDEX "previewkit_secret_application_id_idx" ON "previewkit_secret"("application_id");

-- === org scope ===

ALTER TABLE "previewkit_org_secret_value" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "previewkit_org_secret_value" ADD COLUMN "name" TEXT;

UPDATE "previewkit_org_secret_value" AS v
SET "organization_id" = s."organization_id", "name" = s."name"
FROM "previewkit_org_secret" AS s
WHERE v."org_secret_id" = s."id";

ALTER TABLE "previewkit_org_secret_value" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "previewkit_org_secret_value" ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "previewkit_org_secret_value" DROP CONSTRAINT "previewkit_org_secret_value_org_secret_id_fkey";
DROP INDEX "previewkit_org_secret_value_org_secret_id_key_key";
ALTER TABLE "previewkit_org_secret_value" DROP COLUMN "org_secret_id";

DROP TABLE "previewkit_org_secret";
ALTER TABLE "previewkit_org_secret_value" RENAME TO "previewkit_org_secret";

ALTER TABLE "previewkit_org_secret" RENAME CONSTRAINT "previewkit_org_secret_value_pkey" TO "previewkit_org_secret_pkey";
ALTER TABLE "previewkit_org_secret" RENAME CONSTRAINT "previewkit_org_secret_value_encryption_key_id_fkey" TO "previewkit_org_secret_encryption_key_id_fkey";
ALTER INDEX "previewkit_org_secret_value_encryption_key_id_idx" RENAME TO "previewkit_org_secret_encryption_key_id_idx";

ALTER TABLE "previewkit_org_secret"
    ADD CONSTRAINT "previewkit_org_secret_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "previewkit_org_secret_organization_id_name_key_key"
    ON "previewkit_org_secret"("organization_id", "name", "key");
CREATE INDEX "previewkit_org_secret_organization_id_idx" ON "previewkit_org_secret"("organization_id");
