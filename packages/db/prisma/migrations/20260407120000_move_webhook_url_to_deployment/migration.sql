-- AlterTable: add webhook_url to branch_deployment
ALTER TABLE "branch_deployment" ADD COLUMN "webhook_url" TEXT;

-- AlterTable: add deployment_id to scenario_instance
ALTER TABLE "scenario_instance" ADD COLUMN "deployment_id" TEXT;

-- AddForeignKey
ALTER TABLE "scenario_instance" ADD CONSTRAINT "scenario_instance_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "branch_deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DataMigration: copy webhook_url from application to the main branch's active deployment
UPDATE "branch_deployment" bd
SET "webhook_url" = a."webhook_url"
FROM "application" a
JOIN "branch" b ON b."id" = a."main_branch_id"
WHERE bd."id" = b."deployment_id"
  AND a."webhook_url" IS NOT NULL;
