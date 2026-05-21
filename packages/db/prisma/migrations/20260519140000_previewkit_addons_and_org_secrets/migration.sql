-- Adds the Previewkit addons + org-secrets machinery.
--
-- previewkit_org_secret: org-scoped secret references (one row per
--   org-secret-name) pointing at an AWS Secrets Manager ARN. The AWS SM
--   secret stores a JSON map ({ "token": "..." } for the Neon provider).
--   Referenced from `.preview.yaml` addons via the `auth_secret` field.
--
-- previewkit_addon: per-environment provisioned state of a third-party
--   addon (e.g. a Neon Postgres branch). The provider owns `state`;
--   `outputs` is surfaced into the template engine so apps can reference
--   {{addonName.<key>}}. Successful rows (status='ok') replay cached
--   outputs across PR pushes; any other status retries on next push.

-- CreateEnum
CREATE TYPE "previewkit_addon_status" AS ENUM ('pending', 'ok', 'failed', 'deprovisioned');

-- CreateTable
CREATE TABLE "previewkit_org_secret" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aws_secret_arn" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_org_secret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_org_secret_organization_id_name_key" ON "previewkit_org_secret"("organization_id", "name");

-- CreateIndex
CREATE INDEX "previewkit_org_secret_organization_id_idx" ON "previewkit_org_secret"("organization_id");

-- AddForeignKey
ALTER TABLE "previewkit_org_secret" ADD CONSTRAINT "previewkit_org_secret_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "previewkit_addon" (
    "id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "previewkit_addon_status" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "provisioned_at" TIMESTAMP(3),
    "deprovisioned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_addon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_addon_environment_id_name_key" ON "previewkit_addon"("environment_id", "name");

-- CreateIndex
CREATE INDEX "previewkit_addon_environment_id_idx" ON "previewkit_addon"("environment_id");

-- AddForeignKey
ALTER TABLE "previewkit_addon" ADD CONSTRAINT "previewkit_addon_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "previewkit_environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
