-- CreateEnum
CREATE TYPE "onboarding_agent_holder" AS ENUM ('human', 'agent');

-- AlterTable
ALTER TABLE "onboarding_state" ADD COLUMN     "agent_holder" "onboarding_agent_holder" NOT NULL DEFAULT 'human',
ADD COLUMN     "agent_last_activity_at" TIMESTAMP(3),
ADD COLUMN     "agent_pairing_code" TEXT,
ADD COLUMN     "agent_pairing_expires_at" TIMESTAMP(3),
ADD COLUMN     "agent_pending_request" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_state_agent_pairing_code_key" ON "onboarding_state"("agent_pairing_code");
