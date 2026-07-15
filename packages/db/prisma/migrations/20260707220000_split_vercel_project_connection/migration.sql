-- CreateTable
CREATE TABLE "vercel_project" (
    "id" TEXT NOT NULL,
    "vercel_project_id" TEXT NOT NULL,
    "vercel_installation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "production_url" TEXT,
    "github_repository_id" INTEGER,
    "protection_bypass_secret_enc" TEXT,
    "vercel_check_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vercel_project_pkey" PRIMARY KEY ("id")
);

-- Backfill: one VercelProject row per existing VercelProjectConnection, reusing
-- the connection's id as the project's id so the next step can match them 1:1.
INSERT INTO "vercel_project" (
    "id", "vercel_project_id", "vercel_installation_id", "name",
    "protection_bypass_secret_enc", "vercel_check_id", "created_at", "updated_at"
)
SELECT
    "id", "vercel_project_id", "vercel_installation_id", "vercel_project_name",
    "protection_bypass_secret_enc", "vercel_check_id", "created_at", "updated_at"
FROM "vercel_project_connection";

-- AlterTable
ALTER TABLE "vercel_project_connection"
    ADD COLUMN "project_id" TEXT;

UPDATE "vercel_project_connection" SET "project_id" = "id";

DROP INDEX "vercel_project_connection_vercel_project_id_vercel_installa_key";

ALTER TABLE "vercel_project_connection"
    ALTER COLUMN "project_id" SET NOT NULL,
    DROP CONSTRAINT "vercel_project_connection_vercel_installation_id_fkey",
    DROP COLUMN "vercel_project_id",
    DROP COLUMN "vercel_installation_id",
    DROP COLUMN "vercel_project_name",
    DROP COLUMN "vercel_check_id",
    DROP COLUMN "protection_bypass_secret_enc";

-- CreateIndex
CREATE UNIQUE INDEX "vercel_project_vercel_project_id_vercel_installation_id_key" ON "vercel_project"("vercel_project_id", "vercel_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_project_connection_project_id_key" ON "vercel_project_connection"("project_id");

-- AddForeignKey
ALTER TABLE "vercel_project" ADD CONSTRAINT "vercel_project_vercel_installation_id_fkey" FOREIGN KEY ("vercel_installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_project_connection" ADD CONSTRAINT "vercel_project_connection_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "vercel_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
