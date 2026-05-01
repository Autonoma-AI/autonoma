-- CreateEnum
CREATE TYPE "previewkit_status" AS ENUM ('pending', 'building', 'deploying', 'ready', 'failed', 'torn_down');

-- CreateTable
CREATE TABLE "previewkit_environment" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "head_ref" TEXT NOT NULL,
    "status" "previewkit_status" NOT NULL DEFAULT 'pending',
    "phase" TEXT,
    "error" TEXT,
    "comment_id" TEXT,
    "urls" JSONB NOT NULL DEFAULT '{}',
    "deployed_at" TIMESTAMP(3),
    "torn_down_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "previewkit_environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_build" (
    "id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "status" "previewkit_status" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "app_builds" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "previewkit_build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_app_instance" (
    "id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "image_tag" TEXT NOT NULL,
    "url" TEXT,
    "port" INTEGER NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_app_instance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_environment_namespace_key" ON "previewkit_environment"("namespace");

-- CreateIndex
CREATE INDEX "previewkit_environment_organization_id_status_idx" ON "previewkit_environment"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_environment_repo_full_name_pr_number_key" ON "previewkit_environment"("repo_full_name", "pr_number");

-- CreateIndex
CREATE INDEX "previewkit_build_environment_id_started_at_idx" ON "previewkit_build"("environment_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_app_instance_environment_id_app_name_key" ON "previewkit_app_instance"("environment_id", "app_name");

-- AddForeignKey
ALTER TABLE "previewkit_environment" ADD CONSTRAINT "previewkit_environment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_build" ADD CONSTRAINT "previewkit_build_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "previewkit_environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_app_instance" ADD CONSTRAINT "previewkit_app_instance_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "previewkit_environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
