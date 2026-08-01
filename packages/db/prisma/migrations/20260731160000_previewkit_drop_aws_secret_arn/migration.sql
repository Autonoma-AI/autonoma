-- Nothing reads these any more. AWS Secrets Manager is neither written nor read
-- for previewkit secret values: the API stores them in previewkit_secret_value,
-- the build path reads that, and the runtime K8s Secret is written from it too.
-- The AWS secrets themselves still exist and are untouched by this - dropping the
-- reference does not delete them, so recovery stays possible until they are.
ALTER TABLE "previewkit_secret" DROP COLUMN "aws_secret_arn";
ALTER TABLE "previewkit_org_secret" DROP COLUMN "aws_secret_arn";
