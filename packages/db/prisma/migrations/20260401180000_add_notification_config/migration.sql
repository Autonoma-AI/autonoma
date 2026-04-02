-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('SLACK');

-- CreateTable
CREATE TABLE "notification_config" (
    "id" TEXT NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "slack_webhook_url" TEXT,
    "application_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "notification_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_config_application_id_idx" ON "notification_config"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_config_application_id_channel_key" ON "notification_config"("application_id", "channel");

-- AddForeignKey
ALTER TABLE "notification_config" ADD CONSTRAINT "notification_config_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_config" ADD CONSTRAINT "notification_config_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
