-- AlterEnum
ALTER TYPE "credit_transaction_type" ADD VALUE 'VERCEL_OVERAGE_GRANT';

-- AlterTable
ALTER TABLE "vercel_billing_period" ADD COLUMN     "overage_credits_granted" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vercel_billing_plan" ADD COLUMN     "overage_price_per_credit" DECIMAL(10,6);

-- AlterTable
ALTER TABLE "vercel_installation" ADD COLUMN     "max_overage_amount_usd" DECIMAL(10,2);
