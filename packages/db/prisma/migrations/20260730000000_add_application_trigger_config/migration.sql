-- Per-repo (per-application) activation trigger config: the ready-for-review auto-run toggle and the
-- analysis-trigger label. Absence of a row means the code defaults apply.

-- CreateTable
CREATE TABLE "application_trigger_config" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "auto_run_on_ready_for_review" BOOLEAN NOT NULL DEFAULT false,
    "analysis_trigger_label" TEXT NOT NULL DEFAULT 'autonoma:analyze',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_trigger_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "application_trigger_config_application_id_key" ON "application_trigger_config"("application_id");

-- AddForeignKey
ALTER TABLE "application_trigger_config" ADD CONSTRAINT "application_trigger_config_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
