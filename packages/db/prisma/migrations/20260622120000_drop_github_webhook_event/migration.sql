-- DropForeignKey
ALTER TABLE "github_webhook_event" DROP CONSTRAINT "github_webhook_event_organization_id_fkey";

-- DropTable
DROP TABLE "github_webhook_event";
