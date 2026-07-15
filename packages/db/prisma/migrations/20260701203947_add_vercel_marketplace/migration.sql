-- CreateEnum
CREATE TYPE "vercel_installation_status" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "vercel_billing_period_status" AS ENUM ('pending', 'active', 'completed', 'cancelled', 'expired');

-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'stripe';

-- CreateTable
CREATE TABLE "vercel_billing_plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'subscription',
    "description" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'installation',
    "cost" TEXT NOT NULL,
    "initial_charge" TEXT NOT NULL DEFAULT '0',
    "preauthorization_amount" DECIMAL(10,2),
    "amount_of_runs" INTEGER NOT NULL DEFAULT 0,
    "credits_per_cycle" INTEGER NOT NULL DEFAULT 0,
    "payment_method_required" BOOLEAN NOT NULL DEFAULT true,
    "details" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "level" INTEGER,
    "billing_cycle_days" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "vercel_billing_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_installation" (
    "id" TEXT NOT NULL,
    "vercel_installation_id" TEXT NOT NULL,
    "vercel_account_id" TEXT NOT NULL,
    "vercel_user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "vercel_installation_status" NOT NULL DEFAULT 'active',
    "access_token_enc" TEXT,
    "billing_plan_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vercel_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_resource" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "vercel_installation_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "billing_plan_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vercel_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_billing_period" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT,
    "resource_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "cycle_number" INTEGER NOT NULL DEFAULT 1,
    "start_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "vercel_billing_period_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vercel_billing_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_invoice" (
    "id" TEXT NOT NULL,
    "vercel_invoice_id" TEXT NOT NULL,
    "billing_period_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "vercel_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_project_connection" (
    "id" TEXT NOT NULL,
    "vercel_project_id" TEXT NOT NULL,
    "vercel_installation_id" TEXT NOT NULL,
    "vercel_project_name" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "vercel_check_id" TEXT,
    "protection_bypass_secret_enc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vercel_project_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vercel_deployment" (
    "id" TEXT NOT NULL,
    "vercel_deployment_id" TEXT NOT NULL,
    "vercel_check_run_id" TEXT NOT NULL,
    "project_connection_id" TEXT NOT NULL,
    "branch_snapshot_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vercel_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vercel_billing_plan_name_key" ON "vercel_billing_plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_installation_vercel_installation_id_key" ON "vercel_installation"("vercel_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_resource_resource_id_key" ON "vercel_resource"("resource_id");

-- CreateIndex
CREATE INDEX "vercel_resource_vercel_installation_id_idx" ON "vercel_resource"("vercel_installation_id");

-- CreateIndex
CREATE INDEX "vercel_billing_period_installation_id_status_idx" ON "vercel_billing_period"("installation_id", "status");

-- CreateIndex
CREATE INDEX "vercel_billing_period_resource_id_status_idx" ON "vercel_billing_period"("resource_id", "status");

-- CreateIndex
CREATE INDEX "vercel_billing_period_end_date_idx" ON "vercel_billing_period"("end_date");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_invoice_vercel_invoice_id_key" ON "vercel_invoice"("vercel_invoice_id");

-- CreateIndex
CREATE INDEX "vercel_invoice_billing_period_id_idx" ON "vercel_invoice"("billing_period_id");

-- CreateIndex
CREATE INDEX "vercel_invoice_installation_id_idx" ON "vercel_invoice"("installation_id");

-- CreateIndex
CREATE INDEX "vercel_invoice_vercel_invoice_id_idx" ON "vercel_invoice"("vercel_invoice_id");

-- CreateIndex
CREATE INDEX "vercel_invoice_status_idx" ON "vercel_invoice"("status");

-- CreateIndex
CREATE INDEX "vercel_project_connection_application_id_idx" ON "vercel_project_connection"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_project_connection_vercel_project_id_vercel_installa_key" ON "vercel_project_connection"("vercel_project_id", "vercel_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vercel_deployment_vercel_deployment_id_key" ON "vercel_deployment"("vercel_deployment_id");

-- CreateIndex
CREATE INDEX "vercel_deployment_project_connection_id_idx" ON "vercel_deployment"("project_connection_id");

-- AddForeignKey
ALTER TABLE "vercel_installation" ADD CONSTRAINT "vercel_installation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_installation" ADD CONSTRAINT "vercel_installation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_installation" ADD CONSTRAINT "vercel_installation_billing_plan_id_fkey" FOREIGN KEY ("billing_plan_id") REFERENCES "vercel_billing_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_resource" ADD CONSTRAINT "vercel_resource_vercel_installation_id_fkey" FOREIGN KEY ("vercel_installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_resource" ADD CONSTRAINT "vercel_resource_billing_plan_id_fkey" FOREIGN KEY ("billing_plan_id") REFERENCES "vercel_billing_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_billing_period" ADD CONSTRAINT "vercel_billing_period_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_billing_period" ADD CONSTRAINT "vercel_billing_period_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "vercel_resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_billing_period" ADD CONSTRAINT "vercel_billing_period_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "vercel_billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_invoice" ADD CONSTRAINT "vercel_invoice_billing_period_id_fkey" FOREIGN KEY ("billing_period_id") REFERENCES "vercel_billing_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_invoice" ADD CONSTRAINT "vercel_invoice_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_project_connection" ADD CONSTRAINT "vercel_project_connection_vercel_installation_id_fkey" FOREIGN KEY ("vercel_installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_project_connection" ADD CONSTRAINT "vercel_project_connection_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_deployment" ADD CONSTRAINT "vercel_deployment_project_connection_id_fkey" FOREIGN KEY ("project_connection_id") REFERENCES "vercel_project_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_deployment" ADD CONSTRAINT "vercel_deployment_branch_snapshot_id_fkey" FOREIGN KEY ("branch_snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
