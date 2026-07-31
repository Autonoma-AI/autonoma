-- Postgres is now the store for previewkit secret values, so no AWS secret is
-- created for a new bundle and there is no ARN to record. Existing rows keep
-- theirs: the previewkit runner still reads it as a per-bundle fallback, and the
-- column drops once that reader is gone.
ALTER TABLE "previewkit_secret" ALTER COLUMN "aws_secret_arn" DROP NOT NULL;
ALTER TABLE "previewkit_org_secret" ALTER COLUMN "aws_secret_arn" DROP NOT NULL;
