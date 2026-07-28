-- CreateEnum
CREATE TYPE "scenario_recipe_edit_source" AS ENUM ('PLANNER', 'UI', 'MCP');

-- AlterTable
ALTER TABLE "scenario_instance" ADD COLUMN     "recipe_fingerprint" TEXT,
ADD COLUMN     "recipe_version_id" TEXT;

-- CreateTable
CREATE TABLE "scenario_recipe_edit" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "recipe_version_id" TEXT,
    "snapshot_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fixture_json" JSON NOT NULL,
    "source" "scenario_recipe_edit_source" NOT NULL,
    "actor_user_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_recipe_edit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scenario_recipe_edit_scenario_id_created_at_idx" ON "scenario_recipe_edit"("scenario_id", "created_at");

-- CreateIndex
CREATE INDEX "scenario_recipe_edit_application_id_idx" ON "scenario_recipe_edit"("application_id");

-- CreateIndex
CREATE INDEX "scenario_recipe_edit_organization_id_idx" ON "scenario_recipe_edit"("organization_id");

-- AddForeignKey
ALTER TABLE "scenario_recipe_edit" ADD CONSTRAINT "scenario_recipe_edit_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_recipe_edit" ADD CONSTRAINT "scenario_recipe_edit_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_recipe_edit" ADD CONSTRAINT "scenario_recipe_edit_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

