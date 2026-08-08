-- CreateEnum
CREATE TYPE "previewkit_branch_convention" AS ENUM ('same_branch_name', 'regex', 'manual');

-- CreateEnum
CREATE TYPE "previewkit_hook_group" AS ENUM ('pre_deploy', 'post_deploy');

-- CreateEnum
CREATE TYPE "previewkit_setup_task_frequency" AS ENUM ('on_create', 'every_commit');

-- AlterTable
ALTER TABLE "previewkit_config" ADD COLUMN     "branch_convention_pattern" TEXT,
ADD COLUMN     "branch_convention_replacement" TEXT,
ADD COLUMN     "branch_convention_type" "previewkit_branch_convention",
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "registry" TEXT;

-- CreateTable
CREATE TABLE "previewkit_config_repository" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "repo" TEXT NOT NULL,
    "fallback_branch" TEXT NOT NULL,
    "sha" TEXT,

    CONSTRAINT "previewkit_config_repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_config_app" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "build_context" TEXT,
    "dockerfile" TEXT,
    "build" JSONB,
    "blueprint" JSONB,
    "build_secrets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "port" INTEGER NOT NULL,
    "command" TEXT,
    "health_check" TEXT,
    "primary" BOOLEAN,
    "sdk_implemented" BOOLEAN,
    "resources_cpu" TEXT NOT NULL,
    "resources_memory_request" TEXT NOT NULL,
    "resources_memory_limit" TEXT NOT NULL,
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "previewkit_config_app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_config_connection" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "build_time" BOOLEAN NOT NULL,

    CONSTRAINT "previewkit_config_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_config_service" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "recipe" TEXT NOT NULL,
    "version" TEXT,
    "options" JSONB NOT NULL,
    "resources_cpu" TEXT NOT NULL,
    "resources_memory_request" TEXT NOT NULL,
    "resources_memory_limit" TEXT NOT NULL,
    "s3" BOOLEAN,
    "sqs" BOOLEAN,
    "sns" BOOLEAN,

    CONSTRAINT "previewkit_config_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_config_setup_task" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "command" TEXT NOT NULL,
    "frequency" "previewkit_setup_task_frequency" NOT NULL,
    "location" JSONB NOT NULL,

    CONSTRAINT "previewkit_config_setup_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previewkit_config_hook" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "hook_group" "previewkit_hook_group" NOT NULL,
    "position" INTEGER NOT NULL,
    "app" TEXT NOT NULL,
    "command" TEXT NOT NULL,

    CONSTRAINT "previewkit_config_hook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "previewkit_config_repository_config_id_idx" ON "previewkit_config_repository"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_repository_config_id_position_key" ON "previewkit_config_repository"("config_id", "position");

-- CreateIndex
CREATE INDEX "previewkit_config_app_config_id_idx" ON "previewkit_config_app"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_app_config_id_position_key" ON "previewkit_config_app"("config_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_app_config_id_name_key" ON "previewkit_config_app"("config_id", "name");

-- CreateIndex
CREATE INDEX "previewkit_config_connection_app_id_idx" ON "previewkit_config_connection"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_connection_app_id_position_key" ON "previewkit_config_connection"("app_id", "position");

-- CreateIndex
CREATE INDEX "previewkit_config_service_config_id_idx" ON "previewkit_config_service"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_service_config_id_position_key" ON "previewkit_config_service"("config_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_service_config_id_name_key" ON "previewkit_config_service"("config_id", "name");

-- CreateIndex
CREATE INDEX "previewkit_config_setup_task_service_id_idx" ON "previewkit_config_setup_task"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_setup_task_service_id_position_key" ON "previewkit_config_setup_task"("service_id", "position");

-- CreateIndex
CREATE INDEX "previewkit_config_hook_config_id_idx" ON "previewkit_config_hook"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_config_hook_config_id_hook_group_position_key" ON "previewkit_config_hook"("config_id", "hook_group", "position");

-- AddForeignKey
ALTER TABLE "previewkit_config_repository" ADD CONSTRAINT "previewkit_config_repository_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "previewkit_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_config_app" ADD CONSTRAINT "previewkit_config_app_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "previewkit_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_config_connection" ADD CONSTRAINT "previewkit_config_connection_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "previewkit_config_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_config_service" ADD CONSTRAINT "previewkit_config_service_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "previewkit_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_config_setup_task" ADD CONSTRAINT "previewkit_config_setup_task_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "previewkit_config_service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previewkit_config_hook" ADD CONSTRAINT "previewkit_config_hook_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "previewkit_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
